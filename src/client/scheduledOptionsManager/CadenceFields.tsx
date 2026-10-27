import React from "react";
import { etToUtcCron } from "../options/cronTime";
import { Select, TextInput, Button } from "../components/ui";
import type { ScheduleMode } from "./types";
import { CRON_PRESETS, INTERVAL_PRESETS } from "./format";

export interface CadenceFieldsProps {
  scheduleType: ScheduleMode;
  setScheduleType: React.Dispatch<React.SetStateAction<ScheduleMode>>;
  intervalSeconds: number;
  setIntervalSeconds: React.Dispatch<React.SetStateAction<number>>;
  cronExpression: string;
  setCronExpression: React.Dispatch<React.SetStateAction<string>>;
  delaySeconds: number;
  setDelaySeconds: React.Dispatch<React.SetStateAction<number>>;
  scheduledDate: string;
  setScheduledDate: React.Dispatch<React.SetStateAction<string>>;
}

export function CadenceFields(props: CadenceFieldsProps) {
  const {
    scheduleType,
    setScheduleType,
    intervalSeconds,
    setIntervalSeconds,
    cronExpression,
    setCronExpression,
    delaySeconds,
    setDelaySeconds,
    scheduledDate,
    setScheduledDate,
  } = props;
  return (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
                <div className="sched-form-group">
                  <label htmlFor="sched-cadence-type" className="sched-form-label">Cadence Type</label>
                  <Select id="sched-cadence-type"
                    value={scheduleType}
                    onChange={(e) => setScheduleType(e.target.value as ScheduleMode)}
                  >
                    <option value="interval">Interval (Every X Minutes/Hours)</option>
                    <option value="cron">Cron Expression (Specific Time/Days)</option>
                    <option value="delayed">Delayed (Once, After a Delay)</option>
                    <option value="scheduled">One-Shot (Specific Date &amp; Time)</option>
                  </Select>
                </div>

                {scheduleType === "interval" && (
                  <div className="sched-form-group">
                    <label htmlFor="sched-interval-seconds" className="sched-form-label">Interval Seconds</label>
                    <TextInput id="sched-interval-seconds"
                      type="number"
                      value={intervalSeconds}
                      onChange={(e) => setIntervalSeconds(Number(e.target.value))}
                      min={60}
                      step={60}
                      required
                    />
                    <div className="preset-chips-row">
                      {INTERVAL_PRESETS.map((p) => (
                        <Button
                          key={p.label}
                          type="button"
                          className="preset-chip"
                          onClick={() => setIntervalSeconds(p.seconds)}
                        >
                          {p.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}

                {scheduleType === "cron" && (
                  <div className="sched-form-group">
                    <label htmlFor="sched-cron-expression" className="sched-form-label">Cron Expression</label>
                    <TextInput id="sched-cron-expression"
                      type="text"
                      value={cronExpression}
                      onChange={(e) => setCronExpression(e.target.value)}
                      placeholder="e.g. 30 9 * * 1-5"
                      required
                    />
                    <div className="preset-chips-row">
                      {CRON_PRESETS.map((p) => (
                        <Button
                          key={p.label}
                          type="button"
                          className="preset-chip"
                          onClick={() =>
                            setCronExpression(
                              etToUtcCron({ hour: p.etHour, minute: p.etMinute, daysOfWeek: p.daysOfWeek })
                            )
                          }
                        >
                          {p.label}
                        </Button>
                      ))}
                    </div>
                    <p className="sched-preset-note">
                      Preset times are Eastern (ET) and are converted to UTC when picked, because
                      schedules run in UTC. After the spring or autumn clock change, a saved schedule
                      will fire one hour off its ET label until you re-save it.
                    </p>
                  </div>
                )}

                {scheduleType === "delayed" && (
                  <div className="sched-form-group">
                    <label htmlFor="sched-delay-seconds" className="sched-form-label">Delay Seconds</label>
                    <TextInput id="sched-delay-seconds"
                      type="number"
                      value={delaySeconds}
                      onChange={(e) => setDelaySeconds(Number(e.target.value))}
                      min={1}
                      step={60}
                      required
                    />
                    <p className="sched-preset-note">
                      Runs once, this many seconds after the schedule is saved.
                    </p>
                  </div>
                )}

                {scheduleType === "scheduled" && (
                  <div className="sched-form-group">
                    <label htmlFor="sched-run-at" className="sched-form-label">Run At (One-Shot)</label>
                    <TextInput id="sched-run-at"
                      type="datetime-local"
                      value={scheduledDate}
                      onChange={(e) => setScheduledDate(e.target.value)}
                      required
                    />
                    <p className="sched-preset-note">
                      Runs once at the chosen date and time (your local time).
                    </p>
                  </div>
                )}
              </div>
  );
}
