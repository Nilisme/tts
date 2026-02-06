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

    // Char count update (charCount may not exist in HTML, guard it)
    textInput.addEventListener('input', () => {
        const len = textInput.value.length;
        if (charCount) charCount.textContent = `${len} 字`;
    });

    audioPlayer.addEventListener('ended', () => {
        playNextSegment();
    });

    downloadAllLink.addEventListener('click', (e) => {
        e.preventDefault();
        downloadMergedAudio();
    });

    const modelSelect = document.getElementById('modelSelect'); // New element
    const voiceProfileInput = document.getElementById('voiceProfile');
    const voiceProfileToggle = document.getElementById('voiceProfileToggle');
    const voiceProfileContainer = document.getElementById('voiceProfileContainer');
    const voiceProfileArrow = document.getElementById('voiceProfileArrow');
    const resetVoiceProfileBtn = document.getElementById('resetVoiceProfile');

    // Default voice profile
    const defaultVoiceProfile = voiceProfileInput.value;

    // Voice Profile toggle
    voiceProfileToggle.addEventListener('click', () => {
        const isHidden = voiceProfileContainer.style.display === 'none';
        voiceProfileContainer.style.display = isHidden ? 'block' : 'none';
        voiceProfileArrow.style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)';
    });

    // Reset voice profile to default
    resetVoiceProfileBtn.addEventListener('click', () => {
        voiceProfileInput.value = defaultVoiceProfile;
    });

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

    generateBtn.addEventListener('click', handleGenerateClick);

    async function handleGenerateClick() {
        // If currently generating, STOP it
        if (isGenerating) {
            stopGeneration();
            return;
        }

        const text = textInput.value.trim();
        const apiKey = apiKeyInput.value.trim();
        const voice = voiceSelect.value;
        const model = modelSelect.value;
        const voiceProfile = voiceProfileInput.value.trim();

        if (!text) {
            alert('请输入小说文本内容！');
            return;
        }

        // If segments already exist (resume / retry scenario),
        // reset any 'error' segments back to 'pending' so they get retried
        if (segments.length > 0) {
            const hasPendingWork = segments.some(s => s.status === 'pending' || s.status === 'error');
            if (hasPendingWork) {
                segments.forEach((seg, i) => {
                    if (seg.status === 'error') {
                        seg.status = 'pending';
                        updateSegmentStatus(i, 'pending');
                    }
                });
            } else {
                // All segments are ready — user probably changed text, start fresh
                prepareSegments(text);
            }
        } else {
            prepareSegments(text);
        }

        playerStatus.style.color = ''; // reset error color
        setLoading(true);

        // Start Processing Queue (await to properly handle errors)
        await processQueue(apiKey, voice, model, voiceProfile);
    }

    function stopGeneration() {
        if (abortController) {
            abortController.abort();
            abortController = null;
        }
        isGenerating = false;
        setLoading(false);
        playerStatus.textContent = "已手动停止";
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

    async function processQueue(apiKey, voice, model, voiceProfile) {
        isGenerating = true;
        abortController = new AbortController();
        const CONCURRENCY = 2; // 2-way parallel generation

        // Collect indices of pending segments
        const pendingIndices = [];
        for (let i = 0; i < segments.length; i++) {
            if (segments[i].status === 'pending') pendingIndices.push(i);
        }

        let cursor = 0;       // next index in pendingIndices to dispatch
        let hasError = false;  // flag to stop dispatching new tasks


        function updateProgressUI() {
            const readyCount = segments.filter(s => s.status === 'ready').length;
            const generatingCount = segments.filter(s => s.status === 'generating').length;
            playerStatus.textContent = `正在生成... (已完成 ${readyCount}/${segments.length}，并发 ${generatingCount} 段)`;
            currentProgress.textContent = readyCount;
        }

        // Process a single segment by its index; returns when done
        async function processOne(segIdx) {
            const segment = segments[segIdx];
            segment.status = 'generating'; // local state first
            updateSegmentStatus(segIdx, 'generating');
            updateProgressUI();

            try {
                const result = await generateSegmentAudio(
                    segment.content, voice, model, apiKey, voiceProfile, abortController.signal
                );
                segment.status = 'ready';
                segment.audioUrl = result.audioUrl;
                updateSegmentStatus(segIdx, 'ready');
                updateProgressUI();


            } catch (error) {
                if (error.name === 'AbortError') {
                    // Don't mark as error — user manually stopped
                    if (segment.status === 'generating') {
                        segment.status = 'pending';
                        updateSegmentStatus(segIdx, 'pending');
                    }
                    throw error; // propagate to stop the pool
                }
                console.error(`Segment ${segIdx} failed:`, error);
                segment.status = 'error';
                updateSegmentStatus(segIdx, 'error');
                hasError = true;

                playerStatus.textContent = `生成中断 (第 ${segIdx + 1} 段出错，点击按钮可重试)`;
                playerStatus.style.color = '#ef4444';
                // Abort remaining in-flight requests
                if (abortController) abortController.abort();
                throw error;
            }
        }

        // Promise pool: keep up to CONCURRENCY tasks running at a time
        try {
            const running = new Set();

            while (cursor < pendingIndices.length && !hasError) {
                // Fill up to CONCURRENCY slots
                while (running.size < CONCURRENCY && cursor < pendingIndices.length && !hasError) {
                    const segIdx = pendingIndices[cursor++];
                    const p = processOne(segIdx).then(() => running.delete(p), () => running.delete(p));
                    running.add(p);
                }
                // Wait for at least one to finish before dispatching more
                if (running.size > 0) {
                    await Promise.race(running).catch(() => {});
                }
            }

            // Wait for all remaining in-flight tasks
            if (running.size > 0) {
                await Promise.allSettled(running);
            }
        } catch (e) {
            // Errors already handled inside processOne
        }

        isGenerating = false;
        setLoading(false);

        const allReady = segments.every(s => s.status === 'ready');
        if (allReady) {
            playerStatus.textContent = "全部生成完毕";
            playerStatus.style.color = '';
            downloadAllContainer.classList.remove('hidden');
        } else if (!hasError) {
            playerStatus.textContent = "已停止";
        }
        // If hasError, the error message is already set above
    }

    async function generateSegmentAudio(text, voice, model, apiKey, voiceProfile, signal) {
        const response = await fetch('/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice, model, apiKey, voiceProfile }),
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

            // Use DOM API to avoid XSS from user input
            const statusDiv = document.createElement('div');
            statusDiv.className = 'segment-status';
            statusDiv.innerHTML = '<i class="fa-regular fa-clock"></i>';

            const contentDiv = document.createElement('div');
            contentDiv.className = 'segment-content';

            const p = document.createElement('p');
            p.textContent = seg.content; // safe: textContent escapes HTML

            const meta = document.createElement('div');
            meta.className = 'segment-meta';
            meta.textContent = `片段 ${i + 1}`;

            contentDiv.appendChild(p);
            contentDiv.appendChild(meta);
            el.appendChild(statusDiv);
            el.appendChild(contentDiv);
            segmentsList.appendChild(el);
        });
    }

    function updateSegmentStatus(index, status) {
        const el = document.getElementById(`seg-${index}`);
        if (!el) return;

        el.classList.remove('pending', 'generating', 'error');
        const iconDiv = el.querySelector('.segment-status');

        if (status === 'pending') {
            el.classList.add('pending');
            iconDiv.innerHTML = '<i class="fa-regular fa-clock"></i>';
        } else if (status === 'generating') {
            el.classList.add('generating');
            iconDiv.innerHTML = '<i class="fa-solid fa-spinner"></i>';
        } else if (status === 'ready') {
            iconDiv.innerHTML = '<i class="fa-solid fa-play"></i>';
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
        if (abortController) {
            abortController.abort();
            abortController = null;
        }
        isGenerating = false;
        segments = [];
        currentSegmentIndex = 0;
        audioPlayer.pause();
        audioPlayer.src = "";
        segmentsList.innerHTML = '';
        currentSegmentText.textContent = "...";
    }

    function setLoading(isLoading) {
        // Button is always clickable: either "generate" or "stop"
        generateBtn.disabled = false;
        if (isLoading) {
            btnText.textContent = '停止生成';
            btnIcon.innerHTML = '<i class="fa-solid fa-stop"></i>';
            generateBtn.style.background = 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)';
            loader.classList.remove('hidden');
        } else {
            btnText.textContent = '开始生成音频';
            btnIcon.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>';
            generateBtn.style.background = '';
            loader.classList.add('hidden');
        }
    }
});
