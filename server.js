import express from 'express';
// import { GoogleGenAI } from '@google/genai'; // Removed SDK
import { config } from 'dotenv';
import cors from 'cors';
import wav from 'wav';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import rateLimit from 'express-rate-limit';

// Setup environment
config();

// --- PROXY CONFIGURATION (optional) ---
// Only set proxy if HTTPS_PROXY env var is explicitly provided.
// Without it, fetch goes direct — works on servers / environments that can reach Google directly.
const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
if (PROXY_URL) {
    try {
        const proxyAgent = new ProxyAgent(PROXY_URL);
        setGlobalDispatcher(proxyAgent);
        console.log(`Using Proxy: ${PROXY_URL}`);
    } catch (error) {
        console.warn('Failed to set proxy:', error.message);
    }
} else {
    console.log('No proxy configured (set HTTPS_PROXY env var if needed).');
}
// ---------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 5678;

// Middleware — CORS restricted to same origin
app.use(cors({
    origin: (_origin, callback) => {
        // Allow requests with no origin (same-origin, curl, server-to-server)
        // and requests from the same host (any port on localhost)
        if (!_origin || _origin.startsWith(`http://localhost`) || _origin.startsWith(`http://127.0.0.1`)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    }
}));
app.use(express.json({ limit: '5mb' })); // Limit request body size to prevent abuse

// Rate limiting
const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 30,                  // max 30 requests per minute per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: '请求过于频繁，请稍后再试' },
});
app.use('/api/', apiLimiter);
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

        let currentKeyIndex = 0;

        // Build prompt once (same for all retries)
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

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const currentKey = usableKeys[currentKeyIndex];
            const maskedKey = currentKey.slice(0, 5) + '...';

            // Per-attempt timeout (120s for TTS which can be slow)
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 120000);

            try {
                if (attempt > 1) console.log(`Attempt ${attempt}/${maxRetries} using key ${maskedKey}...`);

                const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${currentKey}`;

                response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    signal: controller.signal
                });

                clearTimeout(timeout);

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
                clearTimeout(timeout);
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

        // Extract Audio Data — search through all parts for inlineData with audio
        const candidate = data.candidates?.[0];
        const parts = candidate?.content?.parts || [];

        let base64Data = null;
        for (const part of parts) {
            if (part?.inlineData?.data) {
                base64Data = part.inlineData.data;
                break;
            }
        }

        console.log(`Gemini API Response: candidates=${data.candidates?.length || 0}, parts=${parts.length}, audio data size=${base64Data?.length || 0} chars`);

        if (!base64Data) {
            // Log the actual response structure for debugging (without huge data)
            const debugParts = parts.map(p => ({ keys: Object.keys(p), hasInlineData: !!p.inlineData, mimeType: p.inlineData?.mimeType }));
            console.error('Response parts structure:', JSON.stringify(debugParts));
            throw new Error("No audio data returned from Gemini API.");
        }
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

        // Calculate actual duration from PCM data
        const sampleRate = 24000;
        const channels = 1;
        const bitDepth = 16;
        const durationSec = audioBuffer.length / (sampleRate * channels * (bitDepth / 8));
        const durationFormatted = `${Math.floor(durationSec / 60)}:${String(Math.floor(durationSec % 60)).padStart(2, '0')}`;

        writer.on('finish', () => {
            res.json({
                success: true,
                audioUrl: `/uploads/${filename}`,
                duration: durationFormatted,
                durationSeconds: Math.round(durationSec)
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
            error: friendlyError(error.message),
        });
    }
});

// Map raw error messages to user-friendly Chinese descriptions
function friendlyError(msg) {
    if (!msg) return '服务器内部错误，请稍后重试';
    const m = msg.toLowerCase();
    if (m.includes('api key not valid') || m.includes('api_key_invalid'))
        return 'API Key 无效，请检查后重试';
    if (m.includes('quota') || m.includes('429') || m.includes('resource_exhausted'))
        return 'API 调用次数已达上限，请稍后再试或更换 Key';
    if (m.includes('permission') || m.includes('403'))
        return 'API Key 权限不足，请确认已开启 Generative Language API';
    if (m.includes('not found') || m.includes('404'))
        return '模型不存在或已下线，请尝试切换模型';
    if (m.includes('abort') || m.includes('timeout') || m.includes('timed out'))
        return '请求超时，请检查网络连接后重试';
    if (m.includes('fetch failed') || m.includes('econnrefused') || m.includes('econnreset'))
        return '无法连接到 Google API，请检查网络或代理设置';
    if (m.includes('no audio data'))
        return 'API 未返回音频数据，请缩短文本或更换模型重试';
    if (m.includes('safety') || m.includes('blocked'))
        return '内容被安全过滤器拦截，请修改文本后重试';
    if (m.includes('invalid argument') || m.includes('400'))
        return '请求参数有误，请检查文本内容和设置';
    // Fallback: return original but truncate if too long
    return msg.length > 100 ? msg.slice(0, 100) + '...' : msg;
}

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
            try {
                const buf = await fsp.readFile(p);
                fileBuffers.push(buf);
            } catch {
                // skip missing files
            }
        }

        if (fileBuffers.length === 0) {
            throw new Error("No valid files found to merge");
        }

        // Parse each WAV to find the actual 'data' chunk offset and extract PCM
        function findDataChunk(buf) {
            // RIFF header: 12 bytes (RIFF + size + WAVE)
            // Then sub-chunks: each has 4-byte id + 4-byte size + data
            let offset = 12;
            while (offset + 8 <= buf.length) {
                const chunkId = buf.toString('ascii', offset, offset + 4);
                const chunkSize = buf.readUInt32LE(offset + 4);
                if (chunkId === 'data') {
                    return { dataOffset: offset + 8, dataSize: chunkSize };
                }
                offset += 8 + chunkSize;
                // WAV chunks are word-aligned (pad to even)
                if (offset % 2 !== 0) offset++;
            }
            // Fallback: assume standard 44-byte header
            return { dataOffset: 44, dataSize: buf.length - 44 };
        }

        // Extract PCM data from each file
        const dataParts = fileBuffers.map(b => {
            const { dataOffset, dataSize } = findDataChunk(b);
            return b.subarray(dataOffset, dataOffset + dataSize);
        });
        const totalDataLength = dataParts.reduce((acc, b) => acc + b.length, 0);
        const combinedData = Buffer.concat(dataParts);

        // Build a clean 44-byte WAV header from the first file's format info
        const src = fileBuffers[0];
        const fmtChunk = (() => {
            let off = 12;
            while (off + 8 <= src.length) {
                if (src.toString('ascii', off, off + 4) === 'fmt ') {
                    return {
                        audioFormat: src.readUInt16LE(off + 8),
                        numChannels: src.readUInt16LE(off + 10),
                        sampleRate:  src.readUInt32LE(off + 12),
                        byteRate:    src.readUInt32LE(off + 16),
                        blockAlign:  src.readUInt16LE(off + 20),
                        bitsPerSample: src.readUInt16LE(off + 22),
                    };
                }
                const sz = src.readUInt32LE(off + 4);
                off += 8 + sz;
                if (off % 2 !== 0) off++;
            }
            // Fallback defaults (matches Gemini TTS output)
            return { audioFormat: 1, numChannels: 1, sampleRate: 24000, byteRate: 48000, blockAlign: 2, bitsPerSample: 16 };
        })();

        const newHeader = Buffer.alloc(44);
        newHeader.write('RIFF', 0);
        newHeader.writeUInt32LE(36 + totalDataLength, 4);
        newHeader.write('WAVE', 8);
        newHeader.write('fmt ', 12);
        newHeader.writeUInt32LE(16, 16);                          // fmt chunk size
        newHeader.writeUInt16LE(fmtChunk.audioFormat, 20);
        newHeader.writeUInt16LE(fmtChunk.numChannels, 22);
        newHeader.writeUInt32LE(fmtChunk.sampleRate, 24);
        newHeader.writeUInt32LE(fmtChunk.byteRate, 28);
        newHeader.writeUInt16LE(fmtChunk.blockAlign, 32);
        newHeader.writeUInt16LE(fmtChunk.bitsPerSample, 34);
        newHeader.write('data', 36);
        newHeader.writeUInt32LE(totalDataLength, 40);

        const finalBuffer = Buffer.concat([newHeader, combinedData]);

        await fsp.writeFile(outputPath, finalBuffer);

        res.json({ success: true, url: `/uploads/${outputFile}` });

    } catch (error) {
        console.error("Merge error:", error);
        res.status(500).json({ error: "音频合并失败，请重试" });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});
