document.addEventListener('DOMContentLoaded', () => {
    // ===== Toast Notification System =====
    const toastContainer = (() => {
        const el = document.createElement('div');
        el.className = 'toast-container';
        document.body.appendChild(el);
        return el;
    })();

    const TOAST_ICONS = {
        warning: 'fa-solid fa-triangle-exclamation',
        error: 'fa-solid fa-circle-xmark',
        success: 'fa-solid fa-circle-check',
        info: 'fa-solid fa-circle-info',
    };

    function showToast(message, type = 'warning', duration = 3500) {
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;

        toast.innerHTML = `
            <i class="toast-icon ${TOAST_ICONS[type] || TOAST_ICONS.info}"></i>
            <span class="toast-message">${message}</span>
            <button class="toast-close"><i class="fa-solid fa-xmark"></i></button>
        `;

        const dismiss = () => {
            toast.classList.add('toast-out');
            toast.addEventListener('animationend', () => toast.remove());
        };

        toast.querySelector('.toast-close').addEventListener('click', dismiss);

        toastContainer.appendChild(toast);

        if (duration > 0) setTimeout(dismiss, duration);

        return toast;
    }

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
            showToast('请上传文本文件 (.txt)', 'warning');
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

    // Drag & drop TXT file onto textarea
    textInput.addEventListener('dragover', (e) => {
        e.preventDefault();
        textInput.classList.add('drag-over');
    });
    textInput.addEventListener('dragleave', () => {
        textInput.classList.remove('drag-over');
    });
    textInput.addEventListener('drop', (e) => {
        e.preventDefault();
        textInput.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (!file) return;
        if (file.type && !file.type.startsWith('text/')) {
            showToast('请拖入文本文件 (.txt)', 'warning');
            return;
        }
        const reader = new FileReader();
        reader.onload = (ev) => {
            textInput.value = ev.target.result;
            textInput.dispatchEvent(new Event('input'));
        };
        reader.readAsText(file, 'UTF-8');
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
    const presetGrid = document.getElementById('presetGrid');
    const customProfileWrapper = document.getElementById('customProfileWrapper');

    // ===== Voice Profile Presets =====
    const VOICE_PRESETS = [
        {
            id: 'romance',
            name: '温柔言情',
            icon: 'fa-solid fa-heart',
            desc: '柔美亲切，适合都市言情/甜宠小说',
            profile: `## AUDIO PROFILE: Serena
An experienced female audiobook narrator specializing in romance novels. Her voice is soft, delicate, and slightly magnetic. She excels at creating atmosphere through voice, immersing listeners in the emotional world of the story.

## THE SCENE
A late-night recording studio bathed in warm amber light, a cup of hot tea resting nearby. The narrator wears headphones, an open romance novel before her, telling a moving love story to her listeners.

### DIRECTOR'S NOTES
Style: Narrate with a soft, intimate, and emotionally rich tone, like telling a love story to a close friend late at night. The voice should feel warm and slightly breathy, drawing the listener into the emotional world of the characters. Maintain absolute consistency in voice character throughout — this is the same narrator across every chapter. Do not add any commentary or response. Simply narrate the text faithfully with feeling.

Pacing: Read at a gentle, unhurried pace. Slow down slightly during emotional or romantic moments to let the feelings linger. Speed up subtly during tense or exciting scenes. Use meaningful pauses after emotionally charged sentences to let the weight of the words settle.

Accent: Standard Mandarin Chinese, soft and elegant pronunciation. Slightly breathy quality on intimate passages.

### TRANSCRIPT`
        },
        {
            id: 'suspense',
            name: '悬疑惊悚',
            icon: 'fa-solid fa-skull',
            desc: '低沉紧迫，适合悬疑/推理/恐怖小说',
            profile: `## AUDIO PROFILE: Vincent
A veteran male audiobook narrator known for his gripping suspense readings. His voice is deep, measured, and carries an undercurrent of tension. He masterfully builds atmosphere through subtle vocal shifts.

## THE SCENE
A dimly lit studio with a single desk lamp casting long shadows. The narrator sits in focused silence, channeling the dark intensity of the story into every word, drawing the listener deeper into the mystery.

### DIRECTOR'S NOTES
Style: Narrate with a low, controlled, and suspenseful tone. Build tension gradually through pacing and vocal intensity. Use a slightly hushed quality during eerie or frightening passages. Keep the voice steady and authoritative to maintain credibility. Do not add any commentary or response. Simply narrate the text faithfully with intensity.

Pacing: Maintain a deliberate, measured pace. Slow down during moments of revelation or horror to heighten suspense. Speed up during chase or action sequences. Use dramatic pauses before key plot twists to let anticipation build.

Accent: Standard Mandarin Chinese, clear and resonant pronunciation. Deeper register for atmosphere.

### TRANSCRIPT`
        },
        {
            id: 'xianxia',
            name: '武侠仙侠',
            icon: 'fa-solid fa-dragon',
            desc: '大气磅礴，适合玄幻/武侠/修仙小说',
            profile: `## AUDIO PROFILE: Tianming
A distinguished narrator with a rich, resonant voice perfect for epic fantasy and martial arts tales. His delivery carries the grandeur of ancient worlds and the thrill of supernatural combat.

## THE SCENE
An ancient study room with scrolls and calligraphy brushes, incense smoke curling in the air. The narrator channels the spirit of a storyteller from ages past, bringing legendary tales of cultivators and heroes to life.

### DIRECTOR'S NOTES
Style: Narrate with a rich, grand, and powerful tone. Bring weight and majesty to descriptions of cultivation breakthroughs, epic battles, and vast landscapes. Use a more restrained, contemplative tone for philosophical or meditative passages. Convey the awe of supernatural powers and ancient worlds. Do not add any commentary or response. Simply narrate the text faithfully with grandeur.

Pacing: Use a steady, flowing pace for world-building descriptions. Accelerate during combat sequences with sharp, energetic delivery. Slow to a reverent pace during moments of enlightenment or emotional depth. Pause meaningfully at chapter transitions and major revelations.

Accent: Standard Mandarin Chinese, with classical elegance and clear enunciation. Strong, resonant tone for battle cries and dramatic moments.

### TRANSCRIPT`
        },
        {
            id: 'casual',
            name: '轻松日常',
            icon: 'fa-solid fa-face-smile',
            desc: '自然活泼，适合都市/校园/轻喜剧小说',
            profile: `## AUDIO PROFILE: Yuki
A young, energetic narrator with a bright and expressive voice. She brings characters to life with natural, conversational delivery that feels like chatting with a friend.

## THE SCENE
A cozy café with soft background music. The narrator sits comfortably with a latte, casually recounting a fun and engaging story to a close friend, with animated expressions and genuine warmth.

### DIRECTOR'S NOTES
Style: Narrate with a light, natural, and conversational tone. Keep the energy warm and upbeat. Express genuine amusement during humorous moments and gentle sincerity during emotional ones. The delivery should feel effortless and relatable. Do not add any commentary or response. Simply narrate the text faithfully with charm.

Pacing: Read at a natural, conversational speed — not too fast, not too slow. Speed up slightly during exciting or funny moments. Slow down gently for reflective passages. Use natural pauses as if speaking spontaneously.

Accent: Standard Mandarin Chinese, youthful and clear pronunciation. Relaxed and approachable vocal quality.

### TRANSCRIPT`
        },
        {
            id: 'news',
            name: '新闻播报',
            icon: 'fa-solid fa-newspaper',
            desc: '专业标准，适合新闻/资讯/知识类内容',
            profile: `## AUDIO PROFILE: Anchor
A professional news anchor with clear, authoritative, and neutral delivery. The voice conveys trustworthiness and objectivity while maintaining listener engagement.

## THE SCENE
A modern broadcast studio with professional equipment. The anchor sits at the news desk with perfect posture, delivering information with precision and clarity.

### DIRECTOR'S NOTES
Style: Narrate with a clear, professional, and neutral tone. Maintain objectivity and authority throughout. Keep the delivery crisp and articulate. Avoid emotional coloring — let the content speak for itself. Do not add any commentary or response. Simply read the text faithfully with professional clarity.

Pacing: Read at a steady, moderate pace optimized for comprehension. Maintain consistent rhythm throughout. Use brief pauses between sentences and slightly longer pauses between paragraphs or topic transitions.

Accent: Standard Mandarin Chinese (Putonghua), broadcast-quality pronunciation. Clear articulation with no regional accent.

### TRANSCRIPT`
        },
        {
            id: 'custom',
            name: '自定义',
            icon: 'fa-solid fa-pen-fancy',
            desc: '自由编写你自己的声音配置文件',
            profile: ''
        }
    ];

    let currentPresetId = 'romance'; // default

    function renderPresetGrid() {
        presetGrid.innerHTML = '';
        VOICE_PRESETS.forEach(preset => {
            const card = document.createElement('div');
            card.className = `preset-card${preset.id === currentPresetId ? ' active' : ''}`;
            card.dataset.presetId = preset.id;
            card.innerHTML = `
                <div class="preset-card-icon"><i class="${preset.icon}"></i></div>
                <div class="preset-card-info">
                    <span class="preset-card-name">${preset.name}</span>
                    <span class="preset-card-desc">${preset.desc}</span>
                </div>
            `;
            card.addEventListener('click', () => selectPreset(preset.id));
            presetGrid.appendChild(card);
        });
    }

    function selectPreset(presetId) {
        currentPresetId = presetId;
        // Update active state on cards
        presetGrid.querySelectorAll('.preset-card').forEach(c => {
            c.classList.toggle('active', c.dataset.presetId === presetId);
        });
        // Show/hide custom textarea
        if (presetId === 'custom') {
            customProfileWrapper.style.display = 'block';
        } else {
            customProfileWrapper.style.display = 'none';
        }
        saveSettings();
    }

    function getActiveVoiceProfile() {
        if (currentPresetId === 'custom') {
            return voiceProfileInput.value.trim();
        }
        const preset = VOICE_PRESETS.find(p => p.id === currentPresetId);
        return preset ? preset.profile : '';
    }

    renderPresetGrid();

    // --- Settings Persistence (localStorage) ---
    const SETTINGS_KEY = 'gemini-tts-settings';

    function saveSettings() {
        try {
            const settings = {
                apiKey: apiKeyInput.value,
                voice: voiceSelect.value,
                model: modelSelect.value,
                segmentLength: document.getElementById('segmentLength').value,
                voicePresetId: currentPresetId,
                customVoiceProfile: voiceProfileInput.value,
            };
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch (e) { /* localStorage unavailable, ignore */ }
    }

    function loadSettings() {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            if (!raw) return;
            const s = JSON.parse(raw);
            if (s.apiKey) apiKeyInput.value = s.apiKey;
            if (s.voice) voiceSelect.value = s.voice;
            if (s.model) modelSelect.value = s.model;
            if (s.segmentLength) document.getElementById('segmentLength').value = s.segmentLength;
            // Voice profile preset
            if (s.voicePresetId) {
                selectPreset(s.voicePresetId);
            } else if (s.voiceProfile) {
                // Migrate from old format: put old value into custom
                voiceProfileInput.value = s.voiceProfile;
                selectPreset('custom');
            }
            if (s.customVoiceProfile) voiceProfileInput.value = s.customVoiceProfile;
        } catch (e) { /* parse error or localStorage unavailable, ignore */ }
    }

    // Restore settings on page load
    loadSettings();

    // Auto-save on change
    apiKeyInput.addEventListener('input', saveSettings);
    voiceSelect.addEventListener('change', saveSettings);
    modelSelect.addEventListener('change', saveSettings);
    document.getElementById('segmentLength').addEventListener('input', saveSettings);
    voiceProfileInput.addEventListener('input', saveSettings);



    const previewBtn = document.getElementById('previewBtn');

    // ...

    previewBtn.addEventListener('click', () => {
        const text = textInput.value.trim();
        if (!text) {
            showToast('请输入小说文本内容！', 'warning');
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
        const voiceProfile = getActiveVoiceProfile();

        if (!text) {
            showToast('请输入小说文本内容！', 'warning');
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
                // All segments are ready — confirm before overwriting
                if (!confirm('当前已有生成完毕的音频，确定要重新生成吗？')) {
                    return;
                }
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
            } else if (isGenerating) {
                // Generation still running — wait and retry (max ~30s)
                playerStatus.textContent = "正在缓冲下一段...";
                const maxBufferRetries = 30;
                let retries = 0;
                const waitForNext = () => {
                    retries++;
                    if (segments[nextIndex].status === 'ready') {
                        playSegment(nextIndex);
                    } else if (retries >= maxBufferRetries || !isGenerating) {
                        playerStatus.textContent = "下一段尚未就绪";
                    } else {
                        setTimeout(waitForNext, 1000);
                    }
                };
                setTimeout(waitForNext, 1000);
            } else {
                playerStatus.textContent = "下一段未生成";
            }
        } else {
            playerStatus.textContent = "播放结束";
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
                else if (seg.status === 'error') retrySingleSegment(i);
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
            iconDiv.innerHTML = '<i class="fa-solid fa-rotate-right"></i>';
        }
    }

    async function retrySingleSegment(index) {
        const segment = segments[index];
        if (!segment || segment.status === 'generating') return;

        const apiKey = apiKeyInput.value.trim();
        const voice = voiceSelect.value;
        const model = modelSelect.value;
        const voiceProfile = getActiveVoiceProfile();

        segment.status = 'generating';
        updateSegmentStatus(index, 'generating');
        playerStatus.textContent = `正在重试第 ${index + 1} 段...`;
        playerStatus.style.color = '';

        try {
            const result = await generateSegmentAudio(
                segment.content, voice, model, apiKey, voiceProfile
            );
            segment.status = 'ready';
            segment.audioUrl = result.audioUrl;
            updateSegmentStatus(index, 'ready');

            const readyCount = segments.filter(s => s.status === 'ready').length;
            playerStatus.textContent = `第 ${index + 1} 段重试成功 (${readyCount}/${segments.length})`;

            // Check if all done
            if (segments.every(s => s.status === 'ready')) {
                playerStatus.textContent = '全部生成完毕';
                downloadAllContainer.classList.remove('hidden');
            }
        } catch (error) {
            console.error(`Retry segment ${index} failed:`, error);
            segment.status = 'error';
            updateSegmentStatus(index, 'error');
            playerStatus.textContent = `第 ${index + 1} 段重试失败，点击可再次重试`;
            playerStatus.style.color = '#ef4444';
        }
    }

    async function downloadMergedAudio() {
        // Filter only ready segments
        const readySegments = segments.filter(s => s.status === 'ready' && s.audioUrl);
        if (readySegments.length === 0) {
            showToast('没有生成好的音频可供下载', 'warning');
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
            showToast('合并下载失败，请单独下载片段。', 'error');
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
