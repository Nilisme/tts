import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { friendlyError, findDataChunk, parseFmtChunk, buildWavHeader } from '../server.js';

// ===== Helper: build a minimal valid WAV buffer =====
function makeWavBuffer(pcmData, opts = {}) {
    const sampleRate = opts.sampleRate || 24000;
    const numChannels = opts.numChannels || 1;
    const bitsPerSample = opts.bitsPerSample || 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = pcmData.length;

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);              // PCM
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmData]);
}

// ===== friendlyError =====
describe('friendlyError', () => {
    it('should return default message for null/undefined/empty', () => {
        assert.equal(friendlyError(null), '服务器内部错误，请稍后重试');
        assert.equal(friendlyError(undefined), '服务器内部错误，请稍后重试');
        assert.equal(friendlyError(''), '服务器内部错误，请稍后重试');
    });

    it('should detect invalid API key', () => {
        assert.equal(friendlyError('API key not valid'), 'API Key 无效，请检查后重试');
        assert.equal(friendlyError('API_KEY_INVALID error'), 'API Key 无效，请检查后重试');
    });

    it('should detect quota / 429 errors', () => {
        assert.equal(friendlyError('quota exceeded'), 'API 调用次数已达上限，请稍后再试或更换 Key');
        assert.equal(friendlyError('Error 429 too many'), 'API 调用次数已达上限，请稍后再试或更换 Key');
        assert.equal(friendlyError('RESOURCE_EXHAUSTED'), 'API 调用次数已达上限，请稍后再试或更换 Key');
    });

    it('should detect permission / 403 errors', () => {
        assert.equal(friendlyError('Permission denied'), 'API Key 权限不足，请确认已开启 Generative Language API');
        assert.equal(friendlyError('HTTP 403 Forbidden'), 'API Key 权限不足，请确认已开启 Generative Language API');
    });

    it('should detect not found / 404 errors', () => {
        assert.equal(friendlyError('Model not found'), '模型不存在或已下线，请尝试切换模型');
        assert.equal(friendlyError('Error 404'), '模型不存在或已下线，请尝试切换模型');
    });

    it('should detect timeout / abort errors', () => {
        assert.equal(friendlyError('Request aborted'), '请求超时，请检查网络连接后重试');
        assert.equal(friendlyError('Connection timeout'), '请求超时，请检查网络连接后重试');
        assert.equal(friendlyError('Request timed out'), '请求超时，请检查网络连接后重试');
    });

    it('should detect network errors', () => {
        assert.equal(friendlyError('fetch failed'), '无法连接到 Google API，请检查网络或代理设置');
        assert.equal(friendlyError('ECONNREFUSED'), '无法连接到 Google API，请检查网络或代理设置');
        assert.equal(friendlyError('ECONNRESET by peer'), '无法连接到 Google API，请检查网络或代理设置');
    });

    it('should detect no audio data', () => {
        assert.equal(friendlyError('No audio data returned'), 'API 未返回音频数据，请缩短文本或更换模型重试');
    });

    it('should detect safety / blocked', () => {
        assert.equal(friendlyError('Content blocked by safety'), '内容被安全过滤器拦截，请修改文本后重试');
    });

    it('should detect invalid argument / 400', () => {
        assert.equal(friendlyError('Invalid argument in request'), '请求参数有误，请检查文本内容和设置');
        assert.equal(friendlyError('HTTP 400 Bad Request'), '请求参数有误，请检查文本内容和设置');
    });

    it('should truncate long unknown messages', () => {
        const longMsg = 'x'.repeat(150);
        const result = friendlyError(longMsg);
        assert.equal(result.length, 103); // 100 + '...'
        assert.ok(result.endsWith('...'));
    });

    it('should return short unknown messages as-is', () => {
        assert.equal(friendlyError('some random error'), 'some random error');
    });
});

// ===== findDataChunk =====
describe('findDataChunk', () => {
    it('should find data chunk in a standard 44-byte header WAV', () => {
        const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
        const wav = makeWavBuffer(pcm);
        const result = findDataChunk(wav);
        assert.equal(result.dataOffset, 44);
        assert.equal(result.dataSize, 4);
    });

    it('should find data chunk when extra chunks exist before data', () => {
        // Build WAV with an extra "LIST" chunk between fmt and data
        const pcm = Buffer.from([0xAA, 0xBB]);
        const listPayload = Buffer.from('test', 'ascii'); // 4 bytes
        const listChunk = Buffer.alloc(8 + listPayload.length);
        listChunk.write('LIST', 0);
        listChunk.writeUInt32LE(listPayload.length, 4);
        listPayload.copy(listChunk, 8);

        const standardWav = makeWavBuffer(pcm);
        // Insert LIST chunk: RIFF(12) + fmt(24) + [LIST] + data
        const riffAndFmt = standardWav.subarray(0, 36); // 12 + 24 = 36
        const dataChunk = standardWav.subarray(36);      // 'data' + size + pcm

        const customWav = Buffer.concat([riffAndFmt, listChunk, dataChunk]);
        // Fix RIFF size
        customWav.writeUInt32LE(customWav.length - 8, 4);

        const result = findDataChunk(customWav);
        assert.equal(result.dataOffset, 36 + listChunk.length + 8); // after LIST + 'data' header
        assert.equal(result.dataSize, 2);
    });

    it('should fallback to 44-byte offset for malformed buffer', () => {
        const garbage = Buffer.alloc(100, 0xFF);
        garbage.write('RIFF', 0);
        garbage.write('WAVE', 8);
        const result = findDataChunk(garbage);
        assert.equal(result.dataOffset, 44);
        assert.equal(result.dataSize, 56); // 100 - 44
    });

    it('should handle very small buffer gracefully', () => {
        const tiny = Buffer.alloc(20, 0);
        const result = findDataChunk(tiny);
        assert.equal(result.dataOffset, 44);
    });
});

// ===== parseFmtChunk =====
describe('parseFmtChunk', () => {
    it('should parse fmt chunk from a standard WAV', () => {
        const wav = makeWavBuffer(Buffer.alloc(100), {
            sampleRate: 44100,
            numChannels: 2,
            bitsPerSample: 16,
        });
        const fmt = parseFmtChunk(wav);
        assert.equal(fmt.audioFormat, 1);
        assert.equal(fmt.numChannels, 2);
        assert.equal(fmt.sampleRate, 44100);
        assert.equal(fmt.bitsPerSample, 16);
        assert.equal(fmt.byteRate, 44100 * 2 * 2);
        assert.equal(fmt.blockAlign, 4);
    });

    it('should return defaults for buffer without fmt chunk', () => {
        const garbage = Buffer.alloc(100, 0);
        garbage.write('RIFF', 0);
        garbage.write('WAVE', 8);
        const fmt = parseFmtChunk(garbage);
        assert.equal(fmt.sampleRate, 24000);
        assert.equal(fmt.numChannels, 1);
        assert.equal(fmt.bitsPerSample, 16);
    });
});

// ===== buildWavHeader =====
describe('buildWavHeader', () => {
    it('should produce a valid 44-byte WAV header', () => {
        const fmt = {
            audioFormat: 1,
            numChannels: 1,
            sampleRate: 24000,
            byteRate: 48000,
            blockAlign: 2,
            bitsPerSample: 16,
        };
        const dataLen = 48000; // 1 second of audio
        const header = buildWavHeader(fmt, dataLen);

        assert.equal(header.length, 44);
        assert.equal(header.toString('ascii', 0, 4), 'RIFF');
        assert.equal(header.readUInt32LE(4), 36 + dataLen);
        assert.equal(header.toString('ascii', 8, 12), 'WAVE');
        assert.equal(header.toString('ascii', 12, 16), 'fmt ');
        assert.equal(header.readUInt32LE(16), 16); // fmt chunk size
        assert.equal(header.readUInt16LE(20), 1);  // PCM
        assert.equal(header.readUInt16LE(22), 1);  // mono
        assert.equal(header.readUInt32LE(24), 24000);
        assert.equal(header.readUInt32LE(28), 48000);
        assert.equal(header.readUInt16LE(32), 2);  // blockAlign
        assert.equal(header.readUInt16LE(34), 16);
        assert.equal(header.toString('ascii', 36, 40), 'data');
        assert.equal(header.readUInt32LE(40), dataLen);
    });

    it('should produce header that can be parsed back by findDataChunk', () => {
        const fmt = { audioFormat: 1, numChannels: 2, sampleRate: 44100, byteRate: 176400, blockAlign: 4, bitsPerSample: 16 };
        const pcm = Buffer.alloc(1000);
        const header = buildWavHeader(fmt, pcm.length);
        const wav = Buffer.concat([header, pcm]);

        const result = findDataChunk(wav);
        assert.equal(result.dataOffset, 44);
        assert.equal(result.dataSize, 1000);

        const parsedFmt = parseFmtChunk(wav);
        assert.equal(parsedFmt.sampleRate, 44100);
        assert.equal(parsedFmt.numChannels, 2);
    });
});

// ===== WAV merge integration =====
describe('WAV merge (integration)', () => {
    it('should correctly merge two WAV files', () => {
        const pcm1 = Buffer.from([0x01, 0x02, 0x03, 0x04]);
        const pcm2 = Buffer.from([0x05, 0x06, 0x07, 0x08]);
        const wav1 = makeWavBuffer(pcm1);
        const wav2 = makeWavBuffer(pcm2);

        // Simulate merge logic from server.js
        const buffers = [wav1, wav2];
        const dataParts = buffers.map(b => {
            const { dataOffset, dataSize } = findDataChunk(b);
            return b.subarray(dataOffset, dataOffset + dataSize);
        });
        const totalDataLength = dataParts.reduce((acc, b) => acc + b.length, 0);
        const combinedData = Buffer.concat(dataParts);
        const fmtChunk = parseFmtChunk(buffers[0]);
        const newHeader = buildWavHeader(fmtChunk, totalDataLength);
        const merged = Buffer.concat([newHeader, combinedData]);

        // Verify merged WAV
        assert.equal(merged.toString('ascii', 0, 4), 'RIFF');
        assert.equal(merged.toString('ascii', 8, 12), 'WAVE');

        const mergedData = findDataChunk(merged);
        assert.equal(mergedData.dataSize, 8); // 4 + 4
        assert.equal(mergedData.dataOffset, 44);

        // Verify PCM data is concatenated correctly
        const pcmResult = merged.subarray(44);
        assert.deepEqual(pcmResult, Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]));
    });
});
