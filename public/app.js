document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const generateBtn = document.getElementById('generateBtn');
    const textInput = document.getElementById('textInput');
    const apiKeyInput = document.getElementById('apiKey');
    const voiceSelect = document.getElementById('voiceSelect');
    const audioResult = document.getElementById('audioResult');
    const emptyState = document.getElementById('emptyState');
    const audioPlayer = document.getElementById('audioPlayer');
    const btnText = document.querySelector('.btn-text');
    const btnIcon = document.querySelector('.btn-icon');
    const loader = document.querySelector('.loader');
    const charCount = document.querySelector('.char-count');

    // New DOM Elements for Playlist
    const playerStatus = document.getElementById('playerStatus');
    const currentSegmentText = document.getElementById('currentSegmentText');
    const currentProgress = document.getElementById('currentProgress');
    const totalSegmentsSpan = document.getElementById('totalSegments');
    const segmentsList = document.getElementById('segmentsList');
    const downloadAllContainer = document.getElementById('downloadAllContainer');
    const downloadAllLink = document.getElementById('downloadAllLink');
    const fileInput = document.getElementById('fileInput');
    const uploadBtn = document.getElementById('uploadBtn');

    // State
    let segments = [];
    let currentSegmentIndex = 0;
    let isGenerating = false;
    let abortController = null;

    // --- Logic ---

    // File Upload Handler
    uploadBtn.addEventListener('click', (e) => {
        e.preventDefault(); // prevent form submission or focus jump
        fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        // Simple check
        if (file.type && !file.type.startsWith('text/')) {
            alert('请上传文本文件 (.txt)');
            return;
        }

        const reader = new FileReader();
        reader.onload = (event) => {
            textInput.value = event.target.result;
            // Trigger input event to update char count
            textInput.dispatchEvent(new Event('input'));
        };
        // Default to UTF-8. If users complain about messy code, we can add GBK support.
        reader.readAsText(file, 'UTF-8');

        // Reset input so same file can be selected again
        fileInput.value = '';
    });

    // Char count update
    textInput.addEventListener('input', () => {
        const len = textInput.value.length;
        charCount.textContent = `${len} 字`;
    });

    generateBtn.addEventListener('click', startGeneration);

    audioPlayer.addEventListener('ended', () => {
        playNextSegment();
    });

    downloadAllLink.addEventListener('click', (e) => {
        e.preventDefault();
        downloadMergedAudio();
    });

    const modelSelect = document.getElementById('modelSelect'); // New element

    const previewBtn = document.getElementById('previewBtn');

    // ...

    previewBtn.addEventListener('click', () => {
        const text = textInput.value.trim();
        if (!text) {
            alert('请输入小说文本内容！');
            return;
        }
        prepareSegments(text);
        // Show status but don't start
        playerStatus.textContent = "分段预览模式";
    });

    generateBtn.addEventListener('click', startGeneration);

    // ...

    async function startGeneration() {
        const text = textInput.value.trim();
        const apiKey = apiKeyInput.value.trim();
        const voice = voiceSelect.value;
        const model = modelSelect.value;

        if (!text) {
            alert('请输入小说文本内容！');
            return;
        }

        // Check if we need to prepare segments (if empty or text changed)
        // For MVP simplicity: if segments is empty, prepare it. 
        // If users clicked preview, segments is already populated.
        // But what if they changed text? Let's just re-prepare to be safe unless we track state complexly.
        // Actually, better UX: if segments exist and are pending, use them.

        if (segments.length === 0 /* || textInput.dirty */) { // strict mode re-prepare
            prepareSegments(text);
        }

        setLoading(true);

        // 2. Start Processing Queue
        processQueue(apiKey, voice, model);
    }

    function prepareSegments(text) {
        resetState();

        // 1. Process Text into Segments (Merged)
        const segmentLenInput = document.getElementById('segmentLength');
        let maxLen = parseInt(segmentLenInput.value) || 300;
        // Safety check
        if (maxLen < 50) maxLen = 50;

        const rawSegments = splitTextSmartly(text, maxLen);

        // Init UI
        totalSegmentsSpan.textContent = rawSegments.length;
        audioResult.classList.remove('hidden');
        emptyState.classList.add('hidden');
        downloadAllContainer.classList.add('hidden');

        // Create Segment Objects and Render
        segments = rawSegments.map((content, index) => ({
            id: index,
            content: content,
            status: 'pending',
            audioUrl: null,
            duration: 0
        }));

        renderSegmentsList();
    }

    async function processQueue(apiKey, voice, model) {
        isGenerating = true;
        abortController = new AbortController();

        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            if (segment.status !== 'pending') continue;

            // Update UI to generating
            updateSegmentStatus(i, 'generating');

            try {
                // Determine if this is the first segment (for "Prepare to Play" UX)
                if (i === 0) {
                    playerStatus.textContent = "正在生成第一段...";
                }

                const result = await generateSegmentAudio(segment.content, voice, model, apiKey, abortController.signal);

                // Success
                segment.status = 'ready';
                segment.audioUrl = result.audioUrl;
                updateSegmentStatus(i, 'ready');

                // Auto-play first segment if player is idle
                if (i === 0 && audioPlayer.paused) {
                    playSegment(0);
                }

            } catch (error) {
                if (error.name === 'AbortError') break;
                console.error(`Segment ${i} failed:`, error);

                segment.status = 'error';
                updateSegmentStatus(i, 'error');

                // STOP ON ERROR:
                // Show explicit message and break the loop so user can fix/retry.
                playerStatus.textContent = `生成中断 (第 ${i + 1} 段出错)`;
                playerStatus.style.color = '#ef4444';

                // Since we stop here, we should ensure the next button click can resume/retry?
                // For now, simple STOP.
                isGenerating = false;
                setLoading(false);
                return; // Exit processQueue entirely
            }
        }

        isGenerating = false;
        setLoading(false);
        playerStatus.textContent = "生成完毕";
        downloadAllContainer.classList.remove('hidden');
    }

    async function generateSegmentAudio(text, voice, model, apiKey, signal) {
        const response = await fetch('/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice, model, apiKey }),
            signal
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || 'API Error');
        }
        return data;
    }

    // --- Playback Logic ---

    function playSegment(index) {
        if (index < 0 || index >= segments.length) return;

        const segment = segments[index];
        if (!segment.audioUrl) return;

        currentSegmentIndex = index;

        // Update Player
        audioPlayer.src = segment.audioUrl;
        audioPlayer.play();

        // Update UI
        currentSegmentText.textContent = segment.content;
        currentProgress.textContent = index + 1;
        playerStatus.textContent = "正在播放";

        // Update List UI
        document.querySelectorAll('.segment-item').forEach(el => el.classList.remove('active', 'playing'));
        const el = document.getElementById(`seg-${index}`);
        if (el) {
            el.classList.add('active', 'playing');
            el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    function playNextSegment() {
        const nextIndex = currentSegmentIndex + 1;
        if (nextIndex < segments.length) {
            const nextSeg = segments[nextIndex];
            if (nextSeg.status === 'ready') {
                playSegment(nextIndex);
            } else {
                // If next not ready, wait a bit or show loading (simple retry for MVP)
                playerStatus.textContent = "正在缓冲下一段...";
                setTimeout(() => playNextSegment(), 1000);
            }
        } else {
            playerStatus.textContent = "播放结束";
            // change icon back?
        }
    }

    // --- Helper Functions ---

    function splitTextSmartly(text, maxLength) {
        if (text.length <= maxLength) {
            return [text];
        }

        const paragraphs = text.split(/\n+/);
        const result = [];
        let buffer = "";

        for (let p of paragraphs) {
            p = p.trim();
            if (!p) continue;

            // Check if adding this paragraph exceeds limit
            if ((buffer + "\n" + p).length <= maxLength) {
                // Determine separator: if buffer ends with punctuation, maybe newline, else space?
                // For novels, newline becomes specific pause usually. 
                // We'll join with newline to preserve structure for TTS pause.
                buffer = buffer ? buffer + "\n" + p : p;
            } else {
                // Buffer is full-ish, push it
                if (buffer) {
                    result.push(buffer);
                    buffer = "";
                }

                // Now check if p itself is too long
                if (p.length > maxLength) {
                    // Split long paragraph
                    const sentences = p.match(/[^。！？.!?]+[。！？.!?]+["”']?|[^。！？.!?]+$/g) || [p];
                    let innerBuf = "";
                    for (let s of sentences) {
                        if ((innerBuf + s).length > maxLength) {
                            if (innerBuf) result.push(innerBuf.trim());
                            innerBuf = s;
                        } else {
                            innerBuf += s;
                        }
                    }
                    if (innerBuf) buffer = innerBuf.trim(); // Start new buffer with remainder
                } else {
                    buffer = p;
                }
            }
        }

        if (buffer) result.push(buffer);

        return result;
    }

    function renderSegmentsList() {
        segmentsList.innerHTML = '';
        segments.forEach((seg, i) => {
            const el = document.createElement('div');
            el.className = 'segment-item pending';
            el.id = `seg-${i}`;
            el.onclick = () => {
                if (seg.status === 'ready') playSegment(i);
            };

            el.innerHTML = `
                <div class="segment-status"><i class="fa-regular fa-clock"></i></div>
                <div class="segment-content">
                    <p>${seg.content}</p>
                    <div class="segment-meta">片段 ${i + 1}</div>
                </div>
            `;
            segmentsList.appendChild(el);
        });
    }

    function updateSegmentStatus(index, status) {
        const el = document.getElementById(`seg-${index}`);
        if (!el) return;

        el.classList.remove('pending', 'generating', 'error');
        const iconDiv = el.querySelector('.segment-status');

        if (status === 'generating') {
            el.classList.add('generating');
            iconDiv.innerHTML = '<i class="fa-solid fa-spinner"></i>';
        } else if (status === 'ready') {
            iconDiv.innerHTML = '<i class="fa-solid fa-play"></i>';
            // Start preloading?
        } else if (status === 'error') {
            el.classList.add('error');
            iconDiv.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i>';
        }
    }

    async function downloadMergedAudio() {
        // Filter only ready segments
        const readySegments = segments.filter(s => s.status === 'ready' && s.audioUrl);
        if (readySegments.length === 0) {
            alert('没有生成好的音频可供下载');
            return;
        }

        const files = readySegments.map(s => s.audioUrl.replace('/uploads/', ''));

        const btn = downloadAllLink;
        const originalText = btn.innerHTML;
        btn.textContent = '正在打包...';
        btn.style.pointerEvents = 'none';

        try {
            const response = await fetch('/api/merge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ files })
            });

            if (!response.ok) throw new Error('Merge failed');

            const data = await response.json();

            // Trigger download
            const link = document.createElement('a');
            link.href = data.url;
            link.download = `novel_full_${Date.now()}.wav`; // merged wav
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

        } catch (e) {
            console.error(e);
            alert("合并下载失败，请单独下载片段。");
        } finally {
            btn.innerHTML = originalText;
            btn.style.pointerEvents = 'auto';
        }
    }

    function resetState() {
        if (abortController) abortController.abort();
        segments = [];
        currentSegmentIndex = 0;
        audioPlayer.pause();
        audioPlayer.src = "";
        segmentsList.innerHTML = '';
        currentSegmentText.textContent = "...";
    }

    function setLoading(isLoading) {
        generateBtn.disabled = isLoading;
        if (isLoading) {
            btnText.textContent = '停止生成'; // Allow stop?
            // Actually for MVP let's just indicate working.
            // If user clicks again, it resets.
            btnIcon.classList.add('hidden');
            loader.classList.remove('hidden');
        } else {
            btnText.textContent = '开始生成音频';
            btnIcon.classList.remove('hidden');
            loader.classList.add('hidden');
        }
    }
});
