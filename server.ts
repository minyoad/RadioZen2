import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync, existsSync } from "fs";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, query, orderBy } from "firebase/firestore";
import { DEFAULT_STATIONS } from "./constants.js"; // Note: might need .js or just constants

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to load JSON safely
const loadJson = (filePath: string) => {
  try {
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf8");
      return JSON.parse(content);
    }
  } catch (e) {
    console.error(`[Server] Failed to load ${filePath}:`, e);
  }
  return null;
};

const firebaseConfig = loadJson(path.join(__dirname, "firebase-applet-config.json"));

// Initialize Firebase Web SDK for Server
const firebaseApp = firebaseConfig ? initializeApp(firebaseConfig) : null;
const db = firebaseApp ? getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId) : null;

if (!firebaseApp) {
  console.warn("[Server] Firebase config not found. Running in standalone mode.");
}

const REMOTE_GIST_URL = "https://gist.githubusercontent.com/minyoad/3fd7fabeb218a7677356af44d21dcb3d/raw/radio_stations.json";

// In-memory cache
let stationsCache: any[] = [];
let lastCacheUpdate = 0;
const CACHE_TTL = 1000 * 60 * 10; // 10 minutes

async function updateStationsCache() {
  try {
    console.log("[Server] Refreshing stations cache...");
    let newCache: any[] = [];
    
    // 1. Try to fetch from Firestore first (if configured)
    if (db) {
      try {
        const stationsCol = collection(db, "stations");
        const q = query(stationsCol, orderBy("name"));
        const snapshot = await getDocs(q);
        if (!snapshot.empty) {
          newCache = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          console.log(`[Server] Loaded ${newCache.length} stations from Firestore.`);
        } else {
          console.log("[Server] Firestore 'stations' collection is empty.");
        }
      } catch (fsError) {
        console.warn("[Server] Firestore fetch failed:", fsError instanceof Error ? fsError.message : fsError);
      }
    }

    // 2. If Firestore was empty or failed, fetch from Gist
    if (newCache.length === 0) {
      console.log("[Server] Fetching from Gist fallback...");
      try {
        const response = await fetch(REMOTE_GIST_URL);
        if (response.ok) {
          const rawData = await response.json();
          if (Array.isArray(rawData)) {
            console.log(`[Server] Gist raw data contains ${rawData.length} items.`);
            newCache = rawData.map((s: any) => {
              const mapped = {
                id: s.id || s.station_id || `gist_${Math.random().toString(36).substr(2, 9)}`,
                name: s.name || s.station_name || s.title || "Unknown Station",
                description: s.description || s.desc || s.name || "",
                streamUrl: s.streamUrl || s.url || s.link || s.station_url || s.stream || "",
                coverUrl: s.coverUrl || s.image || s.logo || s.station_logo || `https://picsum.photos/seed/${s.id || 'radio'}/400/400`,
                tags: s.tags || (s.tag ? [s.tag] : []),
                category: s.category || "music",
                gain: s.gain || 1.0,
                frequency: s.frequency || s.freq || "WEB"
              };
              return mapped;
            }).filter(s => s.streamUrl);
            console.log(`[Server] Loaded and mapped ${newCache.length} stations from Gist.`);
            if (newCache.length > 0) {
              console.log("[Server] First mapped station sample:", JSON.stringify(newCache[0], null, 2));
            }
          }
        } else {
          console.error("[Server] Gist fetch failed with status:", response.status);
        }
      } catch (fetchError) {
        console.error("[Server] Gist fetch failed:", fetchError);
      }
    }

    // 3. Last fallback: use built-in constants
    if (newCache.length === 0) {
      console.log("[Server] Using built-in DEFAULT_STATIONS as final fallback.");
      newCache = [...DEFAULT_STATIONS];
    }

    if (newCache.length > 0) {
      stationsCache = newCache;
      lastCacheUpdate = Date.now();
      console.log(`[Server] Cache update successful. Total stations: ${stationsCache.length}`);
    } else {
      console.error("[Server] Could not load stations from any source.");
    }
  } catch (error) {
    console.error("[Server] Fatal error updating stations cache:", error);
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Logging middleware
  app.use((req, res, next) => {
    console.log(`[Server] ${req.method} ${req.url}`);
    next();
  });

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ 
      status: "ok", 
      stationsCount: stationsCache.length,
      lastUpdate: lastCacheUpdate ? new Date(lastCacheUpdate).toISOString() : null,
      env: process.env.NODE_ENV
    });
  });

  // Background load (initial)
  updateStationsCache().catch(err => console.error("[Server] Initial cache load failed:", err));

  app.get("/api/stations", async (req, res) => {
    try {
      // Refresh cache in background if stale
      if (Date.now() - lastCacheUpdate > CACHE_TTL && lastCacheUpdate !== 0) {
        updateStationsCache().catch(console.error);
      }
      
      const page = parseInt(req.query.page as string) || 1;
      const pageSize = parseInt(req.query.limit as string) || 24;
      const category = req.query.category as string;
      const search = (req.query.search as string || "").toLowerCase();

      let filtered = [...stationsCache];

      if (category && category !== "all") {
        filtered = filtered.filter(s => s.category === category);
      }

      if (search) {
        filtered = filtered.filter(s => 
          (s.name && s.name.toLowerCase().includes(search)) || 
          (s.description && s.description.toLowerCase().includes(search)) ||
          (s.tags && Array.isArray(s.tags) && s.tags.some((t: string) => t.toLowerCase().includes(search)))
        );
      }

      const total = filtered.length;
      const totalPages = Math.ceil(total / pageSize);
      const startIndex = (page - 1) * pageSize;
      const paginated = filtered.slice(startIndex, startIndex + pageSize);

      console.log(`[Server] /api/stations returning ${paginated.length}/${total} stations (Page ${page}/${totalPages})`);

      res.json({
        data: paginated,
        pagination: {
          total,
          page,
          limit: pageSize,
          totalPages
        }
      });
    } catch (error) {
      console.error("[Server] API Error in /api/stations:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.post("/api/admin/refresh-cache", async (req, res) => {
    await updateStationsCache();
    res.json({ status: "ok", count: stationsCache.length });
  });

  // Vite middleware
  if (process.env.NODE_ENV !== "production") {
    console.log("[Server] Starting Vite in middleware mode...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.use((req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Server] Running on http://localhost:${PORT}`);
  });
}

startServer();
