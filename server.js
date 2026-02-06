import express from 'express';
// import { GoogleGenAI } from '@google/genai'; // Removed SDK
import { config } from 'dotenv';
import cors from 'cors';
import wav from 'wav';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

// Setup environment
config();

// --- PROXY CONFIGURATION ---
// Detect if we are running locally and need a proxy to access Google
const PROXY_URL = process.env.HTTPS_PROXY || 'http://127.0.0.1:7890';
try {
    const proxyAgent = new ProxyAgent(PROXY_URL);
    setGlobalDispatcher(proxyAgent);
    console.log(`Using Proxy: ${PROXY_URL}`);
} catch (error) {
    console.warn('Failed to set proxy:', error.message);
}
// ---------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 5678;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Routes
app.post('/api/generate', async (req, res) => {
    try {
        const { text, voice, model, apiKey, voiceProfile } = req.body;

        // Use provided key or fallback to env, supporting comma-separated keys
        let envKeys = [];
        if (process.env.GEMINI_API_KEY) {
            envKeys = process.env.GEMINI_API_KEY.split(',').map(k => k.trim()).filter(k => k);
        }

        const clientKey = apiKey ? apiKey.trim() : null;
        // If client provides a key, use only that. Otherwise use env keys.
        // We prioritize client key but do not rotate it if it fails (unless user provided comma separated too? No, keep simple).
        let usableKeys = clientKey ? [clientKey] : envKeys;

        if (usableKeys.length === 0) {
            return res.status(400).json({ error: "No API Key provided. Please set GEMINI_API_KEY in .env (comma separated for multiple) or provide it in the request." });
        }

        if (!text) {
            return res.status(400).json({ error: "Text is required" });
        }

        const modelName = model || "gemini-2.5-flash-preview-tts";

        console.log(`Generating audio using [${modelName}] - Text length: ${text.length}, Voice: ${voice || 'Puck'}`);

        // Retry logic with Key Rotation
        let response;
        let lastError;
        // Try enough times to cover all keys plus a few transient retries
        const maxRetries = Math.max(usableKeys.length * 2, 5);
        const controller = new AbortController();
        const signal = controller.signal;

        let currentKeyIndex = 0;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const currentKey = usableKeys[currentKeyIndex];
            const maskedKey = currentKey.slice(0, 5) + '...';

            try {
                if (attempt > 1) console.log(`Attempt ${attempt}/${maxRetries} using key ${maskedKey}...`);

                const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${currentKey}`;

                // Build prompt: if voiceProfile is provided, use it as directing context
                // This ensures consistent voice character across all segments
                let promptText;
                if (voiceProfile && voiceProfile.trim()) {
                    promptText = `${voiceProfile.trim()}\n\n${text}`;
                } else {
                    promptText = `Please read the following text exactly as it is written. Do not generate any conversational response. Maintain a consistent, steady narrator voice throughout.\n\n${text}`;
                }

                const payload = {
                    contents: [{
                        parts: [{ text: promptText }]
                    }],
                    generationConfig: {
                        responseModalities: ["AUDIO"],
                        speechConfig: {
                            voiceConfig: {
                                prebuiltVoiceConfig: {
                                    voiceName: voice || "Puck"
                                }
                            }
                        }
                    }
                };

                response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    signal
                });

                if (response.ok) break; // Success!

                const errText = await response.text();
                const status = response.status;

                // If 429 (Too Many Requests), rotate key immediately
                if (status === 429) {
                    console.warn(`Gemini API 429 (Quota Exceeded) on key ${maskedKey}. Rotating key...`);
                    lastError = new Error(`Quota exceeded on key ${maskedKey}`);

                    // Move to next key
                    currentKeyIndex = (currentKeyIndex + 1) % usableKeys.length;

                    // If we have multiple keys, don't wait too long, just switch and retry.
                    // If we looped back to start (and only have 1 key), we might wait a bit.
                    if (usableKeys.length > 1) {
                        continue; // Immediate retry with next key
                    }
                }

                throw new Error(`Gemini API Error: ${status} ${response.statusText} - ${errText}`);

            } catch (err) {
                lastError = err;
                console.error(`Attempt ${attempt} failed:`, err.message);

                // If it wasn't a 429 (which continues above), we wait before retry
                if (attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        }

        if (!response || !response.ok) {
            throw lastError || new Error("Failed to connect to Gemini API after retries");
        }

        const data = await response.json();
        console.log("Gemini API Response:", JSON.stringify(data, null, 2));

        // Extract Audio Data
        const candidate = data.candidates?.[0];
        const audioPart = candidate?.content?.parts?.[0];

        if (!audioPart || !audioPart.inlineData || !audioPart.inlineData.data) {
            throw new Error("No audio data returned from Gemini API.");
        }

        const base64Data = audioPart.inlineData.data;
        const audioBuffer = Buffer.from(base64Data, 'base64');

        // Generate unique filename
        const filename = `tts_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.wav`;
        const filePath = path.join(uploadsDir, filename);

        // Save as WAV
        const writer = new wav.FileWriter(filePath, {
            channels: 1,
            sampleRate: 24000,
            bitDepth: 16
        });

        writer.on('finish', () => {
            res.json({
                success: true,
                audioUrl: `/uploads/${filename}`,
                duration: "Unknown"
            });
        });

        writer.on('error', (err) => {
            console.error("Wav writer error:", err);
            res.status(500).json({ error: "Failed to write audio file." });
        });

        writer.write(audioBuffer);
        writer.end();

    } catch (error) {
        console.error("Error generating speech:", error);
        res.status(500).json({
            error: error.message || "Internal Server Error",
        });
    }
});

// Merge Endpoint
app.post('/api/merge', async (req, res) => {
    try {
        const { files } = req.body;
        if (!files || !Array.isArray(files) || files.length === 0) {
            return res.status(400).json({ error: "No files provided" });
        }

        const outputFile = `merged_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.wav`;
        const outputPath = path.join(uploadsDir, outputFile);

        // Simple WAV merging strategy:
        // 1. Read all files
        // 2. Strip headers (44 bytes standard usually, but better to parse)
        // 3. Concatenate PCM data
        // 4. Write new header + data

        // We will simple read the first file to get format, and then append data from others.
        // NOTE: This assumes all files have same format (which they should from same API)

        const fileBuffers = [];

        for (const file of files) {
            const p = path.join(uploadsDir, path.basename(file)); // security: basename
            if (fs.existsSync(p)) {
                fileBuffers.push(fs.readFileSync(p));
            }
        }

        if (fileBuffers.length === 0) {
            throw new Error("No valid files found to merge");
        }

        // Logic:
        // WAV Header is 44 bytes.
        // We take header from first file.
        // We take data (slice 44) from all files.
        // We update size in header.

        const header = fileBuffers[0].subarray(0, 44);
        const dataParts = fileBuffers.map(b => b.subarray(44));
        const totalDataLength = dataParts.reduce((acc, b) => acc + b.length, 0);

        const combinedData = Buffer.concat(dataParts);

        // Update header fields
        // Offset 4: ChunkSize = 36 + SubChunk2Size
        // Offset 40: SubChunk2Size = totalDataLength

        const newHeader = Buffer.from(header);
        newHeader.writeUInt32LE(totalDataLength + 36, 4);
        newHeader.writeUInt32LE(totalDataLength, 40);

        const finalBuffer = Buffer.concat([newHeader, combinedData]);

        fs.writeFileSync(outputPath, finalBuffer);

        res.json({ success: true, url: `/uploads/${outputFile}` });

    } catch (error) {
        console.error("Merge error:", error);
        res.status(500).json({ error: "Merge failed" });
    }
});

// Start Server
const server = app.listen(0, () => {
    const port = server.address().port;
    console.log(`Server is running at http://localhost:${port}`);
});
