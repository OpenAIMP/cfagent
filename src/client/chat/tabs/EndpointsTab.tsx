import React from "react";
import { McpApiExplorer } from "../../McpApiExplorer";
import { PageShell } from "../../components/ui";

export interface EndpointsTabProps {
}

export function EndpointsTab({}: EndpointsTabProps) {
  return (
          <div className="endpoints-view">
            <PageShell
              title="MCP Explorer"
              scopeNote="Interactive Model Context Protocol (MCP) tool and REST endpoint testing suite"
            >
              <McpApiExplorer />
            </PageShell>
          </div>
  );
}
