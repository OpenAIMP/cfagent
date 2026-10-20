import React from "react";
import { McpApiExplorer } from "../../McpApiExplorer";

export interface EndpointsTabProps {
}

export function EndpointsTab({}: EndpointsTabProps) {
  return (
          <div className="endpoints-view">
            <McpApiExplorer />
          </div>
  );
}
