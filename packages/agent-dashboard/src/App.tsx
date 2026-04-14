import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { AgentsPage } from "./pages/AgentsPage";
import { ChatPage } from "./pages/ChatPage";
import { ConversationsPage } from "./pages/ConversationsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { LivePage } from "./pages/LivePage";
import { TokensPage } from "./pages/TokensPage";
import { ToolsPage } from "./pages/ToolsPage";
import { TracePage } from "./pages/TracePage";

export function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/tools" element={<ToolsPage />} />
          <Route path="/tokens" element={<TokensPage />} />
          <Route path="/live" element={<LivePage />} />
          <Route path="/conversations" element={<ConversationsPage />} />
          <Route path="/conversations/:id/trace" element={<TracePage />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
