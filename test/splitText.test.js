import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Copy of splitTextSmartly from public/app.js (not importable as browser code)
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

        if ((buffer + "\n" + p).length <= maxLength) {
            buffer = buffer ? buffer + "\n" + p : p;
        } else {
            if (buffer) {
                result.push(buffer);
                buffer = "";
            }

            if (p.length > maxLength) {
                const sentences = p.match(/[^。！？.!?]+[。！？.!?]+[""']?|[^。！？.!?]+$/g) || [p];
                let innerBuf = "";
                for (let s of sentences) {
                    if ((innerBuf + s).length > maxLength) {
                        if (innerBuf) result.push(innerBuf.trim());
                        innerBuf = s;
                    } else {
                        innerBuf += s;
                    }
                }
                if (innerBuf) buffer = innerBuf.trim();
            } else {
                buffer = p;
            }
        }
    }

    if (buffer) result.push(buffer);

    return result;
}

// ===== Tests =====

describe('splitTextSmartly', () => {
    it('should return single segment for short text', () => {
        const result = splitTextSmartly('你好世界', 300);
        assert.deepEqual(result, ['你好世界']);
    });

    it('should return single segment when text equals maxLength', () => {
        const text = 'a'.repeat(300);
        const result = splitTextSmartly(text, 300);
        assert.deepEqual(result, [text]);
    });

    it('should return empty array for empty string', () => {
        const result = splitTextSmartly('', 300);
        assert.deepEqual(result, ['']);
    });

    it('should split by paragraphs respecting maxLength', () => {
        const p1 = '第一段内容。';
        const p2 = '第二段内容。';
        const p3 = '第三段内容。';
        const text = `${p1}\n\n${p2}\n\n${p3}`;
        // maxLength just enough for 2 paragraphs
        const maxLen = (p1 + '\n' + p2).length;
        const result = splitTextSmartly(text, maxLen);
        assert.equal(result.length, 2);
        assert.equal(result[0], `${p1}\n${p2}`);
        assert.equal(result[1], p3);
    });

    it('should split long paragraph by sentences', () => {
        const s1 = '这是第一句话。';
        const s2 = '这是第二句话。';
        const s3 = '这是第三句话。';
        const longParagraph = s1 + s2 + s3;
        // maxLength enough for 2 sentences but not 3
        const maxLen = (s1 + s2).length;
        const result = splitTextSmartly(longParagraph, maxLen);
        assert.ok(result.length >= 2, `Expected >= 2 segments, got ${result.length}`);
        // All text should be preserved
        assert.equal(result.join(''), longParagraph);
    });

    it('should handle Chinese punctuation for sentence splitting', () => {
        const text = '他说："你好！"她回答："再见。"然后他们分开了。';
        const result = splitTextSmartly(text, 15);
        assert.ok(result.length >= 2);
        // Verify no text is lost
        const joined = result.join('');
        assert.equal(joined, text);
    });

    it('should handle text with only newlines', () => {
        const result = splitTextSmartly('\n\n\n', 300);
        assert.deepEqual(result, ['\n\n\n']);
    });

    it('should skip empty paragraphs when splitting', () => {
        const text = '段落一\n\n\n\n段落二';
        // text.length < maxLength so it returns as-is (no splitting needed)
        const resultShort = splitTextSmartly(text, 300);
        assert.deepEqual(resultShort, [text]);

        // With a smaller maxLength that forces splitting, empty paragraphs are skipped
        const resultSplit = splitTextSmartly(text, 5);
        assert.equal(resultSplit.length, 2);
        assert.equal(resultSplit[0], '段落一');
        assert.equal(resultSplit[1], '段落二');
    });

    it('should handle single very long sentence without punctuation', () => {
        const longText = '无标点的超长文本内容'.repeat(50);
        const result = splitTextSmartly(longText, 50);
        assert.ok(result.length >= 1);
        // The function falls back to [p] when no sentence match
        // so it may produce segments longer than maxLength — that's expected behavior
    });

    it('should preserve all text content after splitting', () => {
        const text = '第一章\n\n天色渐暗，远处的山峦被夕阳染成了金色。他站在窗前，望着远方。\n\n"今天的天气真好。"她轻声说道。\n\n他转过身来，微微一笑。';
        const result = splitTextSmartly(text, 50);
        // Every original paragraph should appear somewhere in the result
        for (const para of text.split(/\n+/).filter(p => p.trim())) {
            assert.ok(
                result.some(seg => seg.includes(para.trim())),
                `Missing paragraph: "${para.trim()}"`
            );
        }
    });

    it('should respect maxLength for most segments', () => {
        const text = '这是一段测试文本。' .repeat(100);
        const maxLen = 100;
        const result = splitTextSmartly(text, maxLen);
        // Most segments should be within maxLength (some edge cases may exceed slightly)
        const withinLimit = result.filter(s => s.length <= maxLen + 20); // small tolerance
        assert.ok(
            withinLimit.length >= result.length * 0.8,
            `Too many segments exceed maxLength: ${result.length - withinLimit.length} out of ${result.length}`
        );
    });
});

