/**
 * Issue #1181 (#1173 R1): pipeline policy resolution.
 * Pins: sane defaults; precedence defaults < env < settings;
 * clamps; invalid values ignored (never throw); notification
 * toggles + event-list semantics; shouldNotify's full gate.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PIPELINE_POLICY,
  resolvePipelinePolicy,
  shouldNotify,
} from "../src/services/pipelinePolicy";

describe("resolvePipelinePolicy", () => {
  it("defaults: 3 acquisition attempts, notifications fully on", () => {
    const p = resolvePipelinePolicy();
    expect(p.retry.acquisition.maxAttempts).toBe(3);
    expect(p.retry.delivery.maxAttempts).toBe(3);
    expect(p.retry.report.maxAttempts).toBe(2);
    expect(p.notifications.enabled).toBe(true);
    expect(p.notifications.events.failed).toBe(true);
    expect(p.fetchTimeoutMs).toBe(15_000);
    expect(p).toEqual(DEFAULT_PIPELINE_POLICY);
  });

  it("env overrides defaults (shared + per-class)", () => {
    const p = resolvePipelinePolicy({
      PIPELINE_RETRY_ATTEMPTS: "5",
      PIPELINE_DELIVERY_RETRY_ATTEMPTS: "2",
      PIPELINE_RETRY_BASE_DELAY_MS: "100",
    });
    expect(p.retry.acquisition.maxAttempts).toBe(5);
    expect(p.retry.delivery.maxAttempts).toBe(2);
    expect(p.retry.report.maxAttempts).toBe(5);
    expect(p.retry.acquisition.baseDelayMs).toBe(100);
  });

  it("settings beat env (operator tuning without a deploy)", () => {
    const p = resolvePipelinePolicy(
      { PIPELINE_RETRY_ATTEMPTS: "5" },
      { "pipeline.retry.attempts": "4", "pipeline.retry.delivery.attempts": "6" }
    );
    expect(p.retry.acquisition.maxAttempts).toBe(4);
    expect(p.retry.delivery.maxAttempts).toBe(6);
  });

  it("clamps attempts to 1..10 and keeps maxDelay >= baseDelay", () => {
    const p = resolvePipelinePolicy({
      PIPELINE_RETRY_ATTEMPTS: "99",
      PIPELINE_RETRY_BASE_DELAY_MS: "5000",
      PIPELINE_RETRY_MAX_DELAY_MS: "100",
    });
    expect(p.retry.acquisition.maxAttempts).toBe(10);
    expect(p.retry.acquisition.maxDelayMs).toBe(5000);
    const p0 = resolvePipelinePolicy({ PIPELINE_RETRY_ATTEMPTS: "0" });
    expect(p0.retry.acquisition.maxAttempts).toBe(1);
  });

  it("invalid values are ignored, never throw", () => {
    const p = resolvePipelinePolicy({
      PIPELINE_RETRY_ATTEMPTS: "banana",
      PIPELINE_NOTIFICATIONS: "maybe",
      PIPELINE_NOTIFY_EVENTS: "failed,unknown-event",
    });
    expect(p.retry.acquisition.maxAttempts).toBe(3);
    expect(p.notifications.enabled).toBe(true);
    // The one valid event still applies (list semantics: named = on).
    expect(p.notifications.events.failed).toBe(true);
    expect(p.notifications.events.completed).toBe(false);
  });

  it("notification toggles: master, channel, event list, -prefix", () => {
    const off = resolvePipelinePolicy({}, { "pipeline.notifications.enabled": "off" });
    expect(off.notifications.enabled).toBe(false);

    const onlyFailures = resolvePipelinePolicy({ PIPELINE_NOTIFY_EVENTS: "failed,blocked" });
    expect(onlyFailures.notifications.events.failed).toBe(true);
    expect(onlyFailures.notifications.events.blocked).toBe(true);
    expect(onlyFailures.notifications.events.completed).toBe(false);

    const noDelivered = resolvePipelinePolicy({ PIPELINE_NOTIFY_EVENTS: "-delivered" });
    expect(noDelivered.notifications.events.delivered).toBe(false);
    expect(noDelivered.notifications.events.failed).toBe(true);

    // Lifecycle 'started' is a first-class event (#1191).
    expect(resolvePipelinePolicy().notifications.events.started).toBe(true);
    const noStarted = resolvePipelinePolicy({ PIPELINE_NOTIFY_EVENTS: "-started" });
    expect(noStarted.notifications.events.started).toBe(false);
    expect(shouldNotify(noStarted, "started", "slack")).toBe(false);
    expect(shouldNotify(noStarted, "failed", "slack")).toBe(true);

    const noSlack = resolvePipelinePolicy({ PIPELINE_NOTIFY_SLACK: "0" });
    expect(noSlack.notifications.slack).toBe(false);
    expect(noSlack.notifications.email).toBe(true);
  });
});

describe("shouldNotify", () => {
  it("requires master + channel + event all on", () => {
    const p = resolvePipelinePolicy();
    expect(shouldNotify(p, "failed", "slack")).toBe(true);
    expect(shouldNotify(p, "completed", "email")).toBe(true);

    const noSlack = resolvePipelinePolicy({ PIPELINE_NOTIFY_SLACK: "off" });
    expect(shouldNotify(noSlack, "failed", "slack")).toBe(false);
    expect(shouldNotify(noSlack, "failed", "email")).toBe(true);

    const failuresOnly = resolvePipelinePolicy({ PIPELINE_NOTIFY_EVENTS: "failed" });
    expect(shouldNotify(failuresOnly, "completed", "slack")).toBe(false);
    expect(shouldNotify(failuresOnly, "failed", "slack")).toBe(true);

    const masterOff = resolvePipelinePolicy({ PIPELINE_NOTIFICATIONS: "off" });
    expect(shouldNotify(masterOff, "failed", "slack")).toBe(false);
  });
});
