const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const Memory = require("./models/memory");
const User = require("./models/User");
const auth = require("./middleware/Auth");
const OpenAI = require("openai");

const app = express();

app.use(cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
}));
app.use(express.json({ limit: "10mb" }));

// Initialize OpenAI
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const model = genAI.getGenerativeModel({
    model: "models/gemini-flash-latest",
});

// Connect to MongoDB
mongoose
    .connect(process.env.MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch((err) => console.error("❌ MongoDB Error:", err));

app.get("/", (req, res) => {
    res.json({ status: "Memoire Backend Running 🚀" });
});

/* ─────────────────────────────────────────────
   AUTH ROUTES
───────────────────────────────────────────── */

// SIGNUP
app.post("/signup", async(req, res) => {
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ error: "All fields are required" });
        }

        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ error: "User already exists" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const user = new User({ name, email, password: hashedPassword });
        await user.save();

        const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
            expiresIn: "7d",
        });

        res.json({
            message: "Signup successful",
            token,
            user: { _id: user._id, name: user.name, email: user.email },
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Signup failed" });
    }
});

// LOGIN
app.post("/login", async(req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: "Email and password required" });
        }

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(400).json({ error: "User not found" });
        }

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(400).json({ error: "Invalid password" });
        }

        const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
            expiresIn: "7d",
        });

        res.json({
            token,
            user: { _id: user._id, name: user.name, email: user.email },
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Login failed" });
    }
});

// GET current user profile
app.get("/me", auth, async(req, res) => {
    try {
        const user = await User.findById(req.userId).select("-password");
        res.json(user);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch user" });
    }
});

/* ─────────────────────────────────────────────
   MEMORY ROUTES (all protected)
───────────────────────────────────────────── */

// CREATE MEMORY
app.post("/memories", auth, async(req, res) => {
    try {
        const { title, category, content } = req.body;

        if (!title || !content) {
            return res.status(400).json({ error: "Title and content are required" });
        }

        let embedding = [];
        try {
            const embeddingRes = await openai.embeddings.create({
                model: "text-embedding-3-small",
                input: `${title} ${content}`,
            });
            embedding = embeddingRes.data[0].embedding;
        } catch (e) {
            console.warn("Embedding generation failed, using empty:", e.message);
        }

        const memory = new Memory({
            title,
            category: category || "General",
            content,
            embedding,
            userId: req.userId,
        });

        await memory.save();
        res.json(memory);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to create memory" });
    }
});

// GET ALL MEMORIES
app.get("/memories", auth, async(req, res) => {
    try {
        const { category } = req.query;
        const filter = { userId: req.userId };
        if (category && category !== "All") filter.category = category;

        const memories = await Memory.find(filter).sort({ createdAt: -1 });
        res.json(memories);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch memories" });
    }
});

// GET SINGLE MEMORY
app.get("/memories/:id", auth, async(req, res) => {
    try {
        const memory = await Memory.findOne({
            _id: req.params.id,
            userId: req.userId,
        });
        if (!memory) return res.status(404).json({ error: "Memory not found" });
        res.json(memory);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch memory" });
    }
});

// UPDATE MEMORY
app.put("/memories/:id", auth, async(req, res) => {
    try {
        const { title, category, content } = req.body;

        let embedding = [];
        try {
            const embeddingRes = await openai.embeddings.create({
                model: "text-embedding-3-small",
                input: `${title} ${content}`,
            });
            embedding = embeddingRes.data[0].embedding;
        } catch (e) {
            console.warn("Embedding failed:", e.message);
        }

        const memory = await Memory.findOneAndUpdate({ _id: req.params.id, userId: req.userId }, { title, category, content, embedding }, { new: true });

        if (!memory) return res.status(404).json({ error: "Memory not found" });
        res.json(memory);
    } catch (error) {
        res.status(500).json({ error: "Failed to update memory" });
    }
});

// DELETE MEMORY
app.delete("/memories/:id", auth, async(req, res) => {
    try {
        const memory = await Memory.findOneAndDelete({
            _id: req.params.id,
            userId: req.userId,
        });
        if (!memory) return res.status(404).json({ error: "Memory not found" });
        res.json({ message: "Memory deleted" });
    } catch (error) {
        res.status(500).json({ error: "Failed to delete memory" });
    }
});

/* ─────────────────────────────────────────────
   SEARCH
───────────────────────────────────────────── */

app.post("/search", auth, async(req, res) => {
    try {
        const { query } = req.body;
        if (!query) return res.json([]);

        const memories = await Memory.find({ userId: req.userId });

        const filtered = memories.filter((memory) => {
            const q = query.toLowerCase();
            return (
                memory.title.toLowerCase().includes(q) ||
                memory.content.toLowerCase().includes(q) ||
                memory.category.toLowerCase().includes(q)
            );
        });

        res.json(filtered);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Search failed" });
    }
});

/* ─────────────────────────────────────────────
   AI CHAT (RAG)
───────────────────────────────────────────── */

/* CHAT */

app.post("/chat", async(req, res) => {
    try {
        const { message } = req.body;

        // Fetch memories
        const memories = await Memory.find();

        // Build memory context
        const memoryContext = memories
            .map(
                (m) =>
                `Title: ${m.title}
Category: ${m.category}
Content: ${m.content}`
            )
            .join("\n\n");

        // Prompt
        const prompt = `
You are Mémoire AI.

You are an intelligent memory assistant.

Use the following memories to answer naturally.

MEMORIES:
${memoryContext}

USER QUESTION:
${message}
`;

        // Gemini response
        const result = await model.generateContent(prompt);

        const response = result.response.text();

        res.json({
            reply: response,
        });

    } catch (err) {
        console.error(err);

        res.status(500).json({
            reply: "AI failed to respond.",
        });
    }
});
/* ─────────────────────────────────────────────
   ANALYTICS
───────────────────────────────────────────── */

app.get("/analytics", auth, async(req, res) => {
    try {
        const memories = await Memory.find({ userId: req.userId });

        const categoryCount = {};
        memories.forEach((m) => {
            categoryCount[m.category] = (categoryCount[m.category] || 0) + 1;
        });

        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const recentMemories = memories.filter(
            (m) => new Date(m.createdAt) > thirtyDaysAgo
        );

        const dailyCount = {};
        recentMemories.forEach((m) => {
            const date = new Date(m.createdAt).toISOString().split("T")[0];
            dailyCount[date] = (dailyCount[date] || 0) + 1;
        });

        const totalWords = memories.reduce((sum, m) => {
            return sum + m.content.split(" ").length;
        }, 0);

        res.json({
            total: memories.length,
            categories: categoryCount,
            dailyActivity: dailyCount,
            totalWords,
            avgWordsPerMemory: memories.length > 0 ? Math.round(totalWords / memories.length) : 0,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Analytics failed" });
    }
});

/* ─────────────────────────────────────────────
   KNOWLEDGE GRAPH
───────────────────────────────────────────── */

app.get("/graph", auth, async(req, res) => {
    try {
        const memories = await Memory.find({ userId: req.userId });

        const nodes = memories.map((m) => ({
            id: m._id.toString(),
            label: m.title,
            category: m.category,
            size: Math.min(10 + m.content.length / 50, 30),
        }));

        const edges = [];
        for (let i = 0; i < memories.length; i++) {
            for (let j = i + 1; j < memories.length; j++) {
                if (memories[i].category === memories[j].category) {
                    edges.push({
                        source: memories[i]._id.toString(),
                        target: memories[j]._id.toString(),
                        weight: 1,
                    });
                }
            }
        }

        res.json({ nodes, edges });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Graph data failed" });
    }
});


/* AI SUMMARY ROUTE */

app.post("/summary", async(req, res) => {
    try {

        // fetch all memories
        const memories = await Memory.find();

        if (memories.length === 0) {
            return res.json({
                summary: "No memories found to summarize.",
            });
        }

        // format memories for AI
        const memoryText = memories
            .map(
                (m) =>
                `Title: ${m.title}\nContent: ${m.content}\nCategory: ${m.category}`
            )
            .join("\n\n");

        // Gemini prompt
        const prompt = `
You are an AI memory assistant.

Analyze the following memories and generate:
- a concise summary
- main learning themes
- key interests
- important focus areas

Memories:
${memoryText}
`;

        // generate AI response
        const result = await model.generateContent(prompt);

        const response = await result.response;

        const summary = response.text();

        res.json({ summary });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            summary: "Failed to generate summary.",
        });

    }
});

/* AI MEMORY CONNECTIONS */

app.get("/connections", async(req, res) => {

    try {

        // fetch memories
        const memories = await Memory.find();

        if (memories.length < 2) {

            return res.json({
                connections: [],
            });
        }

        // format memories
        const memoryText = memories
            .map(
                (m, index) =>
                `${index + 1}. ${m.title} - ${m.content}`
            )
            .join("\n");

        // AI prompt
        const prompt = `
You are an AI memory analysis system.

Analyze these memories and identify meaningful relationships.

Return ONLY valid JSON in this exact format:

[
  {
    "source": "Memory Title",
    "target": "Memory Title",
    "reason": "Why they are connected"
  }
]

Memories:
${memoryText}
`;

        // Gemini response
        const result = await model.generateContent(prompt);

        const response = await result.response;

        const text = response.text();

        // clean AI output
        const cleaned = text
            .replace(/```json/g, "")
            .replace(/```/g, "")
            .trim();

        // parse JSON
        const connections = JSON.parse(cleaned);

        res.json({
            connections,
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            connections: [],
        });

    }



});


app.post("/ai/reflection", async(req, res) => {

    try {

        const { memories } = req.body;

        const prompt = `
    You are an AI reflection assistant.

    Based on these memories:
    ${memories}

    Write a thoughtful daily reflection in 5-6 lines.
    `;

        const result = await model.generateContent(prompt);

        const response = await result.response;

        const text = response.text();

        res.json({
            reflection: text,
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            error: "Reflection failed",
        });
    }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});