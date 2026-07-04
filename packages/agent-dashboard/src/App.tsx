import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/templates/AppShell";
import { ChatPage } from "./pages/ChatPage";
import { ClaudeCodePage } from "./pages/ClaudeCodePage";
import { ConversationDetailPage } from "./pages/ConversationDetailPage";
import { ConversationsPage } from "./pages/ConversationsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { GraphPage } from "./pages/GraphPage";
import { LivePage } from "./pages/LivePage";
import { TokensPage } from "./pages/TokensPage";
import { ToolsPage } from "./pages/ToolsPage";
import { AgentLensPage } from "./pages/build/AgentLensPage";
import { AgentsRosterPage } from "./pages/build/AgentsRosterPage";
import { CapabilitiesPage } from "./pages/build/CapabilitiesPage";
import { RolesPage } from "./pages/build/RolesPage";
import { EvalComparePage } from "./pages/eval/EvalComparePage";
import { EvalRunDetailPage } from "./pages/eval/EvalRunDetailPage";
import { EvalRunsPage } from "./pages/eval/EvalRunsPage";

export function App() {
  return (
    <BrowserRouter>
      <AppShell>
        <Routes>
          {/* BUILD — the three doors (composition, read-only) */}
          <Route path="/roles" element={<RolesPage />} />
          <Route path="/roles/:id" element={<RolesPage />} />
          <Route path="/agents" element={<AgentsRosterPage />} />
          <Route path="/agents/:id" element={<AgentLensPage />} />
          <Route path="/capabilities" element={<CapabilitiesPage />} />
          <Route path="/capabilities/:id" element={<CapabilitiesPage />} />
          {/* RUN — runtime observability */}
          <Route path="/" element={<DashboardPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/tools" element={<ToolsPage />} />
          <Route path="/tokens" element={<TokensPage />} />
          <Route path="/live" element={<LivePage />} />
          <Route path="/graph" element={<GraphPage />} />
          <Route path="/claude-code" element={<ClaudeCodePage />} />
          <Route path="/conversations" element={<ConversationsPage />} />
          <Route path="/conversations/:id" element={<ConversationDetailPage />} />
          {/* EVALUATE — read-only eval review (#137) + A/B compare (#138) */}
          <Route path="/eval" element={<EvalRunsPage />} />
          <Route path="/eval/runs/:id" element={<EvalRunDetailPage />} />
          <Route path="/eval/compare/:aId/:bId" element={<EvalComparePage />} />
        </Routes>
      </AppShell>
    </BrowserRouter>
  );
}
