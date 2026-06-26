import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/templates/AppShell";
import { AgentsPage } from "./pages/AgentsPage";
import { ChatPage } from "./pages/ChatPage";
import { ClaudeCodePage } from "./pages/ClaudeCodePage";
import { ConversationDetailPage } from "./pages/ConversationDetailPage";
import { ConversationsPage } from "./pages/ConversationsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { GraphPage } from "./pages/GraphPage";
import { LivePage } from "./pages/LivePage";
import { TokensPage } from "./pages/TokensPage";
import { ToolsPage } from "./pages/ToolsPage";

export function App() {
  return (
    <BrowserRouter>
      <AppShell>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/tools" element={<ToolsPage />} />
          <Route path="/tokens" element={<TokensPage />} />
          <Route path="/live" element={<LivePage />} />
          <Route path="/graph" element={<GraphPage />} />
          <Route path="/claude-code" element={<ClaudeCodePage />} />
          <Route path="/conversations" element={<ConversationsPage />} />
          <Route path="/conversations/:id" element={<ConversationDetailPage />} />
        </Routes>
      </AppShell>
    </BrowserRouter>
  );
}
