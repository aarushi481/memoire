const mongoose = require("mongoose");

const memorySchema = new mongoose.Schema({
    title: { type: String, required: true, trim: true },
    category: { type: String, default: "General", trim: true },
    content: { type: String, required: true },
    embedding: { type: [Number], default: [] },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true });

module.exports = mongoose.model("Memory", memorySchema);