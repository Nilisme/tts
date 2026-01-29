import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.join(__dirname, 'public/uploads');

console.log(`Scanning ${uploadsDir}...`);

try {
    const files = fs.readdirSync(uploadsDir)
        .filter(f => f.endsWith('.wav') && !f.startsWith('merged_'))
        .sort(); // Sorts by filename (tts_TIMESTAMP...)

    console.log(`Found ${files.length} files to merge.`);

    if (files.length === 0) {
        console.log("No files to merge.");
        process.exit(0);
    }

    // Read all files
    const fileBuffers = files.map((f, index) => {
        // console.log(`Reading ${f}...`);
        return fs.readFileSync(path.join(uploadsDir, f));
    });

    // Validate headers (basic check)
    // Assume 44 bytes header. 
    // Format: 0-4 'RIFF', 8-12 'WAVE', 12-16 'fmt '
    // Data check: 36-40 'data'

    const header = fileBuffers[0].subarray(0, 44);

    // Check if 'data' is at 36
    const dataMarker = header.subarray(36, 40).toString();
    if (dataMarker !== 'data') {
        console.warn(`Warning: First file header does not have 'data' at offset 36. It has '${dataMarker}'. merging might fail if headers are variable.`);
    }

    const dataParts = fileBuffers.map(b => b.subarray(44));
    const totalDataLength = dataParts.reduce((acc, b) => acc + b.length, 0);
    const combinedData = Buffer.concat(dataParts);

    // Update header
    const newHeader = Buffer.from(header);
    // ChunkSize = 36 + SubChunk2Size
    newHeader.writeUInt32LE(totalDataLength + 36, 4);
    // SubChunk2Size = totalDataLength
    newHeader.writeUInt32LE(totalDataLength, 40);

    const finalBuffer = Buffer.concat([newHeader, combinedData]);

    const timestamp = Date.now();
    const outputPath = path.join(uploadsDir, `merged_all_${timestamp}.wav`);

    fs.writeFileSync(outputPath, finalBuffer);

    console.log(`Successfully merged ${files.length} files into:`);
    console.log(outputPath);

} catch (err) {
    console.error("Error merging files:", err);
    process.exit(1);
}
