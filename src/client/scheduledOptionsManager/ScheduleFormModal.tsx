import React, { useEffect, useState } from "react";
import { Select, TextInput, Modal, Button } from "../components/ui";
import { listPresets, type ScreenerPreset } from "../ScreenerPresetManager";
import type { CreatableJob } from "./types";
import {
  DiscoveryFormSections,
  type DiscoveryFormSectionsProps,
} from "./DiscoveryFormSections";
import { CadenceFields, type CadenceFieldsProps } from "./CadenceFields";
import {
  ThesisRiskFields,
  type ThesisRiskFieldsProps,
} from "./ThesisRiskFields";
import {
  NotificationFields,
  type NotificationFieldsProps,
} from "./NotificationFields";

export interface ScheduleFormModalProps
  extends DiscoveryFormSectionsProps,
    CadenceFieldsProps,
    ThesisRiskFieldsProps,
    NotificationFieldsProps {
  editingScheduleId: string | null;
  submitting: boolean;
  setModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  handleCreateSchedule: (e: React.FormEvent) => Promise<void>;
  setJobType: React.Dispatch<React.SetStateAction<CreatableJob>>;
  targetUniverse: string;
  setTargetUniverse: React.Dispatch<React.SetStateAction<string>>;
  targetSymbols: string;
  setTargetSymbols: React.Dispatch<React.SetStateAction<string>>;
  maxItems: number;
  setMaxItems: React.Dispatch<React.SetStateAction<number>>;
  sector: string;
  setSector: React.Dispatch<React.SetStateAction<string>>;
  minPrice: string;
  setMinPrice: React.Dispatch<React.SetStateAction<string>>;
  maxPrice: string;
  setMaxPrice: React.Dispatch<React.SetStateAction<string>>;
  minMarketCap: string;
  setMinMarketCap: React.Dispatch<React.SetStateAction<string>>;
  maxPe: string;
  setMaxPe: React.Dispatch<React.SetStateAction<string>>;
  trendFilter: string;
  setTrendFilter: React.Dispatch<React.SetStateAction<string>>;
  /** Issue #1499 (#940-E): stored stocks preset for market-screen schedules. */
  presetId: string;
  setPresetId: React.Dispatch<React.SetStateAction<string>>;
  userLogin?: string;
}

export function ScheduleFormModal(props: ScheduleFormModalProps) {
  const {
    editingScheduleId,
    submitting,
    setModalOpen,
    handleCreateSchedule,
    jobType,
    setJobType,
    targetUniverse,
    setTargetUniverse,
    targetSymbols,
    setTargetSymbols,
    maxItems,
    setMaxItems,
    sector,
    setSector,
    minPrice,
    setMinPrice,
    maxPrice,
    setMaxPrice,
    minMarketCap,
    setMinMarketCap,
    maxPe,
    setMaxPe,
    trendFilter,
    setTrendFilter,
    presetId,
    setPresetId,
    userLogin,
  } = props;
  // Issue #1499 (#940-E): the caller's stocks presets for the picker.
  // A failed fetch leaves only "No preset" — it never blocks creating
  // a schedule without one.
  const [stockPresets, setStockPresets] = useState<ScreenerPreset[]>([]);
  const [presetsError, setPresetsError] = useState("");
  useEffect(() => {
    if (props.jobType !== "marketScreen") return;
    let cancelled = false;
    void listPresets(userLogin)
      .then((all) => {
        if (!cancelled) setStockPresets(all.filter((p) => p.assetClass === "stocks"));
      })
      .catch(() => {
        if (!cancelled) setPresetsError("Could not load presets.");
      });
    return () => {
      cancelled = true;
    };
  }, [props.jobType, userLogin]);
  return (
                <Modal open onClose={() => setModalOpen(false)} size="none" panelClassName="sched-modal-card" ariaLabel="Configure screening schedule">
      {/* Parent mounts this modal conditionally; open is always true here. */}
            <header className="sched-modal-header">
              <div>
        <h3>{editingScheduleId ? "✏ Update Screening Schedule" : "⏰ Configure New Schedule"}</h3>
                <p>Register an autonomous persistent timer to run in the background.</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                className="btn-modal-close"
                onClick={() => setModalOpen(false)}
              >
                ✕
              </Button>
            </header>

            <form onSubmit={handleCreateSchedule} style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
              {/* Job Picker */}
              {!editingScheduleId && (
                <div className="sched-form-group">
                  <label htmlFor="sched-job-type" className="sched-form-label">
                    Job
                    <span className="hint">What runs when this schedule fires</span>
                  </label>
                  <Select id="sched-job-type"
                    value={jobType}
                    onChange={(e) => {
                      const nextJobType = e.target.value as CreatableJob;
                      setJobType(nextJobType);
                      if (nextJobType === "marketScreen" && !targetUniverse) setTargetUniverse("NASDAQ100");
                    }}
                  >
                    <option value="optionsAnalysis">Autonomous Options Analysis</option>
                    <option value="marketScreen">Autonomous Market Screen (Stocks)</option>
                    <option value="strategyDiscovery">Saved-View Strategy Discovery</option>
                  </Select>
                </div>
              )}

              {/* Target Universe or Symbols */}
              {jobType !== "strategyDiscovery" && (editingScheduleId || jobType === "optionsAnalysis" || jobType === "marketScreen") && (
                <div className="sched-form-group">
                  <label htmlFor="sched-target-universe" className="sched-form-label">
                    Target Universe
                    <span className="hint">Screens all symbols in the universe</span>
                  </label>
                  <Select id="sched-target-universe"
                    value={targetUniverse}
                    onChange={(e) => setTargetUniverse(e.target.value)}
                  >
                    {jobType === "optionsAnalysis" && <option value="">Custom symbols (below)</option>}
                    <option value="TECH">Technology (keyword discovery)</option>
                    <option value="NASDAQ100">Nasdaq-100</option>
                    <option value="SP100">S&P 100</option>
                    <option value="SP500">S&P 500</option>
                    <option value="RUSSELL2000">Russell 2000</option>
                    <option value="ETF">ETFs</option>
                    <option value="LEV_ETF">Leveraged ETFs</option>
                  </Select>
                  {!targetUniverse && jobType === "optionsAnalysis" && (
                    <>
                      <label htmlFor="sched-target-symbols" className="sched-form-label" style={{ marginTop: "0.5rem" }}>
                        Target Equity Symbols
                        <span className="hint">Comma-separated tickers</span>
                      </label>
                      <TextInput id="sched-target-symbols"
                        type="text"
                        value={targetSymbols}
                        onChange={(e) => setTargetSymbols(e.target.value)}
                        placeholder="e.g. NVDA, AAPL, SPY, MSFT"
                        required
                      />
                    </>
                  )}
                </div>
              )}

              {jobType !== "strategyDiscovery" && (
                <div className="sched-form-group">
                  <label htmlFor="sched-max-items" className="sched-form-label">
                    Max items
                    <span className="hint">Maximum live symbols scanned per run; 0 means all selected symbols.</span>
                  </label>
                  <TextInput id="sched-max-items"
                    type="number"
                    min={0}
                    step={1}
                    value={maxItems}
                    onChange={(e) => setMaxItems(Number(e.target.value))}
                    required
                  />
                </div>
              )}

              {/* Sector Selection (Market Screen) */}
              {jobType === "marketScreen" && (
                <div className="sched-form-group">
                  <label htmlFor="sched-sector" className="sched-form-label">
                    Sector
                    <span className="hint">Filter stocks by sector or screen all sectors</span>
                  </label>
                  <Select id="sched-sector"
                    value={sector}
                    onChange={(e) => setSector(e.target.value)}
                  >
                    <option value="Technology">Technology</option>
                    <option value="ALL">ALL (All Sectors — Recommended)</option>
                    <option value="Financials">Financials</option>
                    <option value="Healthcare">Healthcare</option>
                    <option value="Consumer Discretionary">Consumer Discretionary</option>
                    <option value="Industrials">Industrials</option>
                    <option value="Energy">Energy</option>
                    <option value="Communication Services">Communication Services</option>
                    <option value="Materials">Materials</option>
                    <option value="Utilities">Utilities</option>
                    <option value="Real Estate">Real Estate</option>
                  </Select>
                </div>
              )}

              {/* Saved preset (Market Screen, #1499) */}
              {jobType === "marketScreen" && (
                <div className="sched-form-group">
                  <label htmlFor="sched-preset" className="sched-form-label">
                    Saved criteria preset
                    <span className="hint">A preset replaces the custom thresholds below; its current criteria resolve at run time, so preset edits apply to future runs. A deleted preset fails the run loudly instead of running unfiltered.</span>
                  </label>
                  <Select id="sched-preset"
                    value={presetId}
                    onChange={(e) => setPresetId(e.target.value)}
                  >
                    <option value="">No preset (custom thresholds)</option>
                    {stockPresets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                    {presetId && !stockPresets.some((p) => p.id === presetId) && (
                      <option value={presetId}>
                        {presetId} (no longer exists)
                      </option>
                    )}
                  </Select>
                  {presetsError && <span className="hint">{presetsError}</span>}
                </div>
              )}

              {/* Optional Custom Criteria (Market Screen) */}
              {jobType === "marketScreen" && (
                <details style={{ marginTop: "0.25rem", padding: "var(--space-2) var(--space-3)", background: "var(--color-surface-sunken)", borderRadius: "6px", border: "1px solid var(--color-border-subtle)" }}>
                  <summary style={{ fontSize: "0.84rem", cursor: "pointer", color: "var(--color-accent)", fontWeight: 600, userSelect: "none" }}>
                    ⚙️ Custom Screening Criteria &amp; Filters (Optional)
                  </summary>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-3)", marginTop: "0.6rem" }}>
                    <div className="sched-form-group">
                      <label htmlFor="sched-filter-min-price" className="sched-form-label">Min Price ($)</label>
                      <TextInput id="sched-filter-min-price"
                        type="number"
                        min={0}
                        step="0.5"
                        value={minPrice}
                        onChange={(e) => setMinPrice(e.target.value)}
                        placeholder="e.g. 5"
                      />
                    </div>
                    <div className="sched-form-group">
                      <label htmlFor="sched-filter-max-price" className="sched-form-label">Max Price ($)</label>
                      <TextInput id="sched-filter-max-price"
                        type="number"
                        min={0}
                        step="0.5"
                        value={maxPrice}
                        onChange={(e) => setMaxPrice(e.target.value)}
                        placeholder="e.g. 500"
                      />
                    </div>
                    <div className="sched-form-group">
                      <label htmlFor="sched-filter-min-cap" className="sched-form-label">Min Mkt Cap ($B)</label>
                      <TextInput id="sched-filter-min-cap"
                        type="number"
                        min={0}
                        step="1"
                        value={minMarketCap}
                        onChange={(e) => setMinMarketCap(e.target.value)}
                        placeholder="e.g. 1"
                      />
                    </div>
                    <div className="sched-form-group">
                      <label htmlFor="sched-filter-max-pe" className="sched-form-label">Max P/E Ratio</label>
                      <TextInput id="sched-filter-max-pe"
                        type="number"
                        min={0}
                        step="1"
                        value={maxPe}
                        onChange={(e) => setMaxPe(e.target.value)}
                        placeholder="e.g. 50"
                      />
                    </div>
                  </div>
                  <div className="sched-form-group" style={{ marginTop: "0.5rem" }}>
                    <label htmlFor="sched-filter-trend" className="sched-form-label">Price Trend / Momentum</label>
                    <Select id="sched-filter-trend"
                      value={trendFilter}
                      onChange={(e) => setTrendFilter(e.target.value)}
                    >
                      <option value="">Any (Standard momentum)</option>
                      <option value="bullish_breakout">Bullish Breakout</option>
                      <option value="bearish_pullback">Bearish Pullback</option>
                      <option value="high_relative_volume">High Relative Volume</option>
                    </Select>
                  </div>
                </details>
              )}

              <DiscoveryFormSections
                jobType={props.jobType}
                discoveryInputModel={props.discoveryInputModel}
                setDiscoveryInputModel={props.setDiscoveryInputModel}
                discoveryRequests={props.discoveryRequests}
                setDiscoveryRequests={props.setDiscoveryRequests}
                updateDiscoveryRequest={props.updateDiscoveryRequest}
                derivedSource={props.derivedSource}
                setDerivedSource={props.setDerivedSource}
                derivedSymbolsText={props.derivedSymbolsText}
                setDerivedSymbolsText={props.setDerivedSymbolsText}
                derivedWatchlistName={props.derivedWatchlistName}
                setDerivedWatchlistName={props.setDerivedWatchlistName}
                derivedProfileId={props.derivedProfileId}
                setDerivedProfileId={props.setDerivedProfileId}
                profiles={props.profiles}
                profilesError={props.profilesError}
                selectedDerivedProfileReason={props.selectedDerivedProfileReason}
                noViewDraft={props.noViewDraft}
                updateNoViewDraft={props.updateNoViewDraft}
                noViewDivergent={props.noViewDivergent}
              />
              <CadenceFields
                scheduleType={props.scheduleType}
                setScheduleType={props.setScheduleType}
                intervalSeconds={props.intervalSeconds}
                setIntervalSeconds={props.setIntervalSeconds}
                cronExpression={props.cronExpression}
                setCronExpression={props.setCronExpression}
                delaySeconds={props.delaySeconds}
                setDelaySeconds={props.setDelaySeconds}
                scheduledDate={props.scheduledDate}
                setScheduledDate={props.setScheduledDate}
              />
              <ThesisRiskFields
                jobType={props.jobType}
                thesis={props.thesis}
                setThesis={props.setThesis}
                riskProfile={props.riskProfile}
                setRiskProfile={props.setRiskProfile}
              />
              <NotificationFields
                jobType={props.jobType}
                pushToSlack={props.pushToSlack}
                setPushToSlack={props.setPushToSlack}
                slackChannel={props.slackChannel}
                setSlackChannel={props.setSlackChannel}
                emailTo={props.emailTo}
                setEmailTo={props.setEmailTo}
                webhookUrl={props.webhookUrl}
                setWebhookUrl={props.setWebhookUrl}
              />
              <footer className="sched-modal-footer">
                <Button
                  type="button"
                  className="btn-sched-secondary"
                  onClick={() => setModalOpen(false)}
                  disabled={submitting}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  className="btn-sched-primary"
                  disabled={submitting}
                >
                  {submitting
                    ? "Saving Schedule…"
                    : editingScheduleId
                    ? "✓ Save Updated Schedule"
                    : "✓ Register Durable Schedule"}
                </Button>
              </footer>
            </form>
                  </Modal>
  );
}
