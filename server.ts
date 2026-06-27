import express from "express";
import path from "path";
import dns from "dns";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import apiApp from "./api/index.js";

// Load environment variables
dotenv.config();

// Ensure Node standardizes to IPv4 first to avoid localhost lookup latency
dns.setDefaultResultOrder("ipv4first");

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT as string, 10) : 3000;

  // Health check for Render
  app.get('/health', (req, res) => {
    res.status(200).send('OK');
  });

  // Mount API routes from the separated module for Vercel
  app.use(apiApp);

  // Catch-all for unhandled API routes so they don't fall through to Vite SPA fallback
  app.use("/api", (req, res, next) => {
    res.status(404).json({ error: "API Route Not Found" });
  });
  
  // API Error handler
  app.use("/api", (err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("API Error:", err);
    res.status(500).json({ error: "Internal API Error", message: err.message });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Srade Operating Server running on port ${PORT}`);
  });
}

startServer();
