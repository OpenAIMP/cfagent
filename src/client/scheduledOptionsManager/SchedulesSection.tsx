import React from "react";
import { EmptyState, Button } from "../components/ui";
import type { ScheduledTaskItem } from "./types";
import { ScheduleCard, type ScheduleCardProps } from "./ScheduleCard";

export interface SchedulesSectionProps extends Omit<ScheduleCardProps, "item"> {
  schedules: ScheduledTaskItem[];
  loading: boolean;
  fetchSchedules: () => Promise<void>;
  openCreateModal: () => void;
}

export function SchedulesSection(props: SchedulesSectionProps) {
  const { schedules, loading, fetchSchedules, openCreateModal, ...cardProps } = props;
  return (
      <section className="sched-section-card">
        <header className="sched-section-header">
          <h4>
            <span>⏱️</span> Active Durable Schedules
            <span className="sched-count-pill">{schedules.length} Active</span>
          </h4>
          <Button
            type="button"
            className="btn-sched-action-sm"
            onClick={fetchSchedules}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "↻ Refresh"}
          </Button>
        </header>

        {schedules.length === 0 && !loading ? (
          <EmptyState
            icon="📅"
            description="Create a stock screen, options analysis, or saved-view discovery schedule to see it here; legacy app-created jobs are not recreated automatically."
            title="No active schedules"
            action={<Button
              type="button"
              className="btn-sched-primary"
              onClick={openCreateModal}
            >
              + Create First Schedule
            </Button>}
          />
        ) : (
          <div className="schedules-grid">
            {schedules.map((item) => (
              <ScheduleCard key={item.id} item={item} {...cardProps} />
            ))}
          </div>
        )}
      </section>
  );
}
