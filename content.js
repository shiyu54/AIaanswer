// Content Script - 题目识别和自动答题

(function () {
  "use strict";

  // State
  let questions = [];
  let answeredCount = 0;
  let isRunning = false;
  let config = null;

  // ---- 题库 & 记忆系统 ----
  const BANK_KEY = "aiQuestionBank";
  let _bankCache = null;

  async function _getBank() {
    if (_bankCache) return _bankCache;
    const d = await chrome.storage.local.get(BANK_KEY);
    _bankCache = d[BANK_KEY] || {};
    return _bankCache;
  }
  async function _saveBank() {
    if (_bankCache) await chrome.storage.local.set({ [BANK_KEY]: _bankCache });
  }
  async function _pruneBank(max = 2000) {
    const b = await _getBank();
    const ks = Object.keys(b);
    if (ks.length <= max) return;
    const sorted = ks.map(k => ({ k, t: b[k].lastUsed || 0 })).sort((a, b) => a.t - b.t);
    for (const { k } of sorted.slice(0, ks.length - max)) delete b[k];
    await _saveBank();
  }

  async function lookupBank(text) {
    const key = text.substring(0, 120);
    const bank = await _getBank();
    if (bank[key]) { bank[key].count++; bank[key].lastUsed = Date.now(); await _saveBank(); return { hit: true, ...bank[key] }; }
    for (const [sk, rec] of Object.entries(bank)) {
      if (key.includes(sk) || sk.includes(key)) { rec.count++; rec.lastUsed = Date.now(); await _saveBank(); return { hit: true, ...rec }; }
    }
    return { hit: false };
  }

  async function saveToBank(text, answer, type, explanation) {
    const key = text.substring(0, 120);
    const bank = await _getBank();
    if (bank[key]) { bank[key].count++; bank[key].lastUsed = Date.now(); }
    else { bank[key] = { question: text, answer, type: type || "single", explanation: explanation || "", count: 1, createdAt: Date.now(), lastUsed: Date.now() }; }
    await _saveBank(); _pruneBank(2000);
  }

  async function getBankStats() {
    const e = Object.values(await _getBank());
    return { total: e.length, totalHits: e.reduce((s, x) => s + (x.count || 0), 0) };
  }

  async function getBankEntries() {
    return Object.values(await _getBank()).map(e => ({ ...e, hash: e.question ? e.question.substring(0, 120) : "" })).sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  }

  async function deleteBankEntry(hash) {
    const bank = await _getBank();
    if (bank[hash]) delete bank[hash];
    else { for (const k of Object.keys(bank)) { if (bank[k].question && bank[k].question.substring(0, 120) === hash) { delete bank[k]; break; } } }
    await _saveBank();
  }

  async function clearBank() { _bankCache = {}; await chrome.storage.local.remove(BANK_KEY); }
  // ---- 题库结束 ----
  // ---- 答题历史记录 ----
  const HISTORY_KEY = "aiAnswerHistory";
  
  async function saveAnswerHistory(questionText, answer, type, source) {
    try {
      const d = await chrome.storage.local.get(HISTORY_KEY);
      const list = d[HISTORY_KEY] || [];
      list.push({
        time: Date.now(),
        question: questionText.substring(0, 300),
        answer: Array.isArray(answer) ? answer.join(", ") : String(answer),
        type: type || "single",
        source: source || "AI",  // "AI" or "bank"
      });
      // 最多保留 500 条
      if (list.length > 500) list.splice(0, list.length - 500);
      await chrome.storage.local.set({ [HISTORY_KEY]: list });
    } catch(e) { console.warn("[AI答题助手] 保存历史失败:", e); }
  }

  async function getAnswerHistory() {
    const d = await chrome.storage.local.get(HISTORY_KEY);
    return (d[HISTORY_KEY] || []).slice(-200).reverse();
  }

  async function clearAnswerHistory() {
    await chrome.storage.local.remove(HISTORY_KEY);
  }
  // ---- 历史记录结束 ----

  // Question selectors for common exam platforms
  const QUESTION_SELECTORS = [
    // 通用选择器
    ".question",
    ".question-item",
    ".exam-question",
    ".test-question",
    ".quiz-question",
    ".topic",
    ".subject",
    ".rowQuestion",
    '[class*="question"]',
    '[class*="Question"]',
    '[class*="topic"]',
    '[class*="subject"]',
    // 题目容器
    ".problem",
    ".problem-item",
    ".exercise",
    ".exercise-item",
    // 表单题目
    "form .item",
    "form .form-item",
    "form .field",
    // 列表题目
    ".question-list > li",
    ".question-list > div",
    "ol.questions > li",
    "ul.questions > li",
    // 行内题目
    ".field-group",
    ".question-group",
    ".exam-content > div",
    ".test-content > div",
    // 通用卡片/条目
    ".card.question",
    ".list-item.question",
    '.el-card:has(input)',
    '.el-form-item:has(input)',
  ];

  // Option selectors
  const OPTION_SELECTORS = [
    'input[type="radio"]',
    'input[type="checkbox"]',
    ".option",
    ".choice",
    ".answer-option",
    '[class*="option"]',
    '[class*="choice"]',
    "label",
  ];

  // Fill-in-the-blank selectors
  const FILL_SELECTORS = [
    'input[type="text"]',
    "input:not([type])",
    "textarea",
    ".blank",
    ".fill-blank",
    '[class*="blank"]',
    '[contenteditable="true"]',
  ];

  // AI分析得到的选择器缓存
  let aiDetectedSelectors = null;

  // Message listener
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
      case "scan":
        config = message.config;
        handleScan(sendResponse);
        return true; // 保持消息通道开放用于异步响应
      case "start":
        config = message.config;
        startAnswering();
        sendResponse({ success: true });
        break;
      case "stop":
        stopAnswering();
        sendResponse({ success: true });
        break;
      case "getStatus":
        sendResponse({
          questionCount: questions.length,
          answeredCount,
          isRunning,
        });
        break;
      case "getBankStats":
        getBankStats().then(s => sendResponse(s));
        return true;
      case "getBankEntries":
        getBankEntries().then(e => sendResponse(e));
        return true;
      case "deleteBankEntry":
        deleteBankEntry(message.hash).then(() => sendResponse({ success: true }));
        return true;
      case "clearBank":
        clearBank().then(() => sendResponse({ success: true }));
        return true;
      case "getAnswerHistory":
        getAnswerHistory().then(h => sendResponse(h));
        return true;
      case "clearAnswerHistory":
        clearAnswerHistory().then(() => sendResponse({ success: true }));
        return true;
    }
    return true;
  });

  // 处理扫描请求
  async function handleScan(sendResponse) {
    if (!config) {
      sendResponse({ success: false, count: 0, message: "请先配置API" });
      return;
    }

    // 步骤1: 尝试匹配站点模板
    sendLog("info", "正在匹配站点模板...");
    const template = window.siteMatcher.matchTemplate(window.location.href);

    if (template) {
      sendLog("info", `已匹配到站点模板: ${template.siteName}`);

      try {
        // 使用模板扫描
        const scanner = new window.EnhancedScanner();
        const result = scanner.scanWithTemplate(template);

        if (result.success && result.count > 0) {
          // 模板扫描成功
          questions = result.questions;
          answeredCount = 0;
          updateStats();

          sendLog("success", `使用模板扫描成功，发现 ${result.count} 道题目`);

          // 更新模板统计
          await window.templateManager.updateStats(template.siteId, "success");

          sendResponse({ success: true, count: result.count, message: "" });
          return;
        } else {
          // 模板扫描失败，回退到AI分析
          sendLog("warning", `模板扫描失败，回退到AI分析...`);
          await window.templateManager.updateStats(template.siteId, "fail");
        }
      } catch (error) {
        sendLog("error", `模板扫描出错: ${error.message}，回退到AI分析`);
        await window.templateManager.updateStats(template.siteId, "fail");
      }
    } else {
      sendLog("info", "未找到匹配的站点模板，使用AI分析...");
    }

    // 步骤2: 使用AI分析（无模板或模板失败时）
    sendLog("info", "正在使用AI分析页面结构，请耐心等待...");

    try {
      const aiResult = await analyzePageWithAI();
      if (aiResult && aiResult.success) {
        aiDetectedSelectors = aiResult.selectors;
        const count = scanWithAISelectors(aiResult);
        if (count > 0) {
          sendLog("success", `AI分析成功，发现 ${count} 道题目`);
          sendResponse({ success: true, count, message: "" });
        } else {
          sendLog("warning", "AI分析完成，但未能定位到题目元素");
          sendResponse({
            success: false,
            count: 0,
            message: "未能定位到题目元素",
          });
        }
      } else {
        sendLog("warning", "AI分析未发现题目");
        sendResponse({ success: false, count: 0, message: "未发现题目" });
      }
    } catch (error) {
      sendLog("error", `AI分析失败: ${error.message}`);
      sendResponse({ success: false, count: 0, message: error.message });
    }
  }

  // Scan for questions on the page
  function scanQuestions() {
    questions = [];
    answeredCount = 0;

    // Try each selector
    for (const selector of QUESTION_SELECTORS) {
      try {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          elements.forEach((el, index) => {
            const question = parseQuestion(el, index);
            if (question) {
              questions.push(question);
            }
          });
          if (questions.length > 0) break;
        }
      } catch (e) {
        console.log("Selector error:", selector, e);
      }
    }

    // If no questions found with selectors, try heuristic detection
    if (questions.length === 0) {
      questions = detectQuestionsHeuristically();
    }

    // Remove duplicates
    questions = removeDuplicates(questions);

    sendLog("info", `扫描完成，发现 ${questions.length} 道题目`);
    updateStats();

    return questions.length;
  }

  // Parse a question element
  function parseQuestion(element, index) {
    const question = {
      index,
      element,
      type: null,
      text: "",
      options: [],
      inputs: [],
      answered: false,
    };

    // Get question text
    const textElements = element.querySelectorAll(
      "p, span, div, h1, h2, h3, h4, h5, h6"
    );
    let questionText = "";

    // Try to find the main question text
    const titleEl = element.querySelector(
      '.title, .question-title, .question-text, .stem, [class*="title"], [class*="stem"]'
    );
    if (titleEl) {
      questionText = titleEl.textContent.trim();
    } else {
      // Get first meaningful text
      for (const el of textElements) {
        const text = el.textContent.trim();
        if (text.length > 10 && !text.match(/^[A-D][\.\、\s]/)) {
          questionText = text;
          break;
        }
      }
    }

    if (!questionText) {
      questionText = element.textContent.trim().substring(0, 500);
    }

    question.text = cleanText(questionText);

    // Detect question type and get options/inputs
    const radios = element.querySelectorAll('input[type="radio"]');
    const checkboxes = element.querySelectorAll('input[type="checkbox"]');
    const textInputs = element.querySelectorAll(
      'input[type="text"], input:not([type]), textarea'
    );
    const selects = element.querySelectorAll("select");

    if (radios.length > 0) {
      question.type = "single";
      question.options = parseOptions(element, radios);
    } else if (checkboxes.length > 0) {
      question.type = "multiple";
      question.options = parseOptions(element, checkboxes);
    } else if (selects.length > 0) {
      question.type = "single";
      question.options = Array.from(selects[0].options)
        .filter(opt => opt.value && opt.value !== "")
        .map((opt, i) => ({
          element: selects[0],
          label: String.fromCharCode(65 + i),
          text: opt.text.trim(),
          value: opt.value,
        }));
      // 把 select 本身也存下来用于后续填写
      question.selectElement = selects[0];
    } else if (textInputs.length > 0) {
      question.type = "fill";
      question.inputs = Array.from(textInputs);
    } else {
      // Try to detect from text
      if (
        question.text.includes("多选") ||
        question.text.includes("多项选择")
      ) {
        question.type = "multiple";
      } else if (
        question.text.includes("单选") ||
        question.text.includes("单项选择")
      ) {
        question.type = "single";
      } else if (
        question.text.includes("填空") ||
        question.text.includes("____") ||
        question.text.includes("___")
      ) {
        question.type = "fill";
      }

      // Try to find clickable options
      const optionEls = element.querySelectorAll(
        '.option, .choice, [class*="option"], [class*="choice"], li'
      );
      if (optionEls.length >= 2 && optionEls.length <= 8) {
        question.type = question.type || "single";
        question.options = Array.from(optionEls).map((el, i) => ({
          element: el,
          label: String.fromCharCode(65 + i),
          text: el.textContent.trim(),
        }));
      }
    }

    // Skip if no valid type detected
    if (!question.type) {
      return null;
    }

    return question;
  }

  // Parse options from input elements
  function parseOptions(container, inputs) {
    const options = [];

    inputs.forEach((input, index) => {
      const label =
        input.closest("label") ||
        container.querySelector(`label[for="${input.id}"]`) ||
        input.parentElement;

      let optionText = "";
      let optionLabel = String.fromCharCode(65 + index);

      if (label) {
        optionText = label.textContent.trim();
        // Extract label letter if present
        const match = optionText.match(/^([A-Z])[\.\、\s]/);
        if (match) {
          optionLabel = match[1];
          optionText = optionText.substring(match[0].length).trim();
        }
      }

      options.push({
        element: input,
        label: optionLabel,
        text: optionText,
      });
    });

    return options;
  }

  // Heuristic question detection — 智能扫描，不再遍历所有DOM
  function detectQuestionsHeuristically() {
    const results = [];

    // 优先级1: 层叠式容器选择器（逐个试，不卡）
    const patterns = [
      ".question-item", ".question", ".exam-question", ".test-question",
      ".quiz-question", ".problem", ".problem-item",
      '[class*="questionList"] > *', '[class*="question-list"] > *',
      '[class*="examContent"] > *', '[class*="quizContent"] > *',
      "ol > li", "ul > li",
    ];
    for (const sel of patterns) {
      let items;
      try { items = document.querySelectorAll(sel); } catch { continue; }
      if (items.length < 2) continue;
      let v = 0;
      for (const el of items) {
        if (el.querySelectorAll('input[type="radio"],input[type="checkbox"],input[type="text"],textarea,select').length > 0
            && (el.textContent || "").trim().length > 5) v++;
      }
      if (v < 2) continue;
      for (const el of items) { const q = parseQuestion(el, results.length); if (q) results.push(q); }
      if (results.length > 0) break;
    }

    // 优先级2: 兜底 — 只扫描包含 input/select 的容器
    if (results.length === 0) {
      const seen = new Set();
      document.querySelectorAll(
        'input[type="radio"],input[type="checkbox"],input[type="text"],textarea,input:not([type]),select'
      ).forEach(inp => {
        let cur = inp.parentElement;
        for (let d = 0; cur && d < 4; cur = cur.parentElement, d++) {
          const text = (cur.textContent || "").trim();
          if (text.length > 15) {
            const key = cur.tagName + "." + (cur.className || "") + "#" + (cur.id || "");
            if (!seen.has(key)) { seen.add(key); const q = parseQuestion(cur, results.length); if (q) results.push(q); }
            break;
          }
        }
      });
    }

    return results;
  }

  // 统一的DOM精简逻辑，去掉无关属性
  function simplifyElementAttributes(el) {
    const keepAttrs = [
      "class",
      "id",
      "type",
      "name",
      "value",
      "placeholder",
      "for",
      "data-index",
      "data-id",
    ];
    const attrs = Array.from(el.attributes || []);
    attrs.forEach((attr) => {
      if (!keepAttrs.includes(attr.name) && !attr.name.startsWith("data-")) {
        el.removeAttribute(attr.name);
      }
    });
    Array.from(el.children).forEach((child) =>
      simplifyElementAttributes(child)
    );
  }

  // 获取简化的页面HTML用于AI分析（作为候选块不足时的兜底）
  function getSimplifiedHTML() {
    const clone = document.body.cloneNode(true);
    const removeSelectors = [
      "script",
      "style",
      "noscript",
      "iframe",
      "svg",
      "img",
      "video",
      "audio",
      "canvas",
    ];
    removeSelectors.forEach((sel) => {
      clone.querySelectorAll(sel).forEach((el) => el.remove());
    });

    simplifyElementAttributes(clone);

    let html = clone.innerHTML;
    html = html.replace(/\s+/g, " ").replace(/>\s+</g, "><");

    if (html.length > 30000) {
      const mainSelectors = [
        "main",
        "article",
        ".content",
        ".main",
        "#content",
        "#main",
        ".container",
        ".wrapper",
      ];
      for (const sel of mainSelectors) {
        const main = clone.querySelector(sel);
        if (main && main.innerHTML.length > 500) {
          html = main.innerHTML.replace(/\s+/g, " ").replace(/>\s+</g, "><");
          break;
        }
      }
    }

    if (html.length > 30000) {
      html = html.substring(0, 30000) + "... [内容已截断]";
    }

    return html;
  }

  // 构建单个题目块的精简HTML字符串
  function buildSimplifiedBlockHTML(element, maxLength = 1500) {
    const clone = element.cloneNode(true);
    simplifyElementAttributes(clone);
    let html = clone.outerHTML || "";
    html = html.replace(/\s+/g, " ").replace(/>\s+</g, "><");
    if (html.length > maxLength) {
      html = html.substring(0, maxLength) + "... [片段截断]";
    }
    return html;
  }

  // 根据页面内容尝试提取候选题目块，显著减少发送给AI的数据量
  function getCandidateQuestionBlocks(maxBlocks = 40) {
    const candidateSet = new Set();

    function addCandidate(el) {
      if (!el || candidateSet.has(el)) return;
      candidateSet.add(el);
    }

    const optionInputs = document.querySelectorAll(
      'input[type="radio"], input[type="checkbox"]'
    );
    optionInputs.forEach((input) => {
      const container = findQuestionContainer(input.closest("label") || input);
      if (container) addCandidate(container);
    });

    const fillInputs = document.querySelectorAll(
      'input[type="text"], input[type="number"], textarea'
    );
    fillInputs.forEach((input) => {
      const container = findQuestionContainer(input.closest("label") || input);
      if (container) addCandidate(container);
    });

    if (candidateSet.size < 5) {
      const extraSelectors = [
        ".question",
        ".exam-question",
        ".topic",
        ".subject",
        ".problem",
      ];
      extraSelectors.forEach((sel) => {
        document.querySelectorAll(sel).forEach((el) => addCandidate(el));
      });
    }

    const candidates = Array.from(candidateSet).slice(0, maxBlocks);
    return candidates
      .map((el) => {
        const text = cleanText(el.textContent || "").substring(0, 400);
        return {
          text,
          html: buildSimplifiedBlockHTML(el),
        };
      })
      .filter((block) => block.text);
  }

  // 构建AI分析所需的内容，如果候选块为空则回退到整页HTML
  function buildAIAnalysisPayload() {
    const blocks = getCandidateQuestionBlocks();
    if (blocks.length > 0) {
      const formatted = blocks
        .map((block, index) => {
          return `【题目块${index + 1}】\n文本：${block.text}\nHTML：${
            block.html
          }`;
        })
        .join("\n\n");

      return {
        payload: `以下是筛选后的疑似题目区域（共${blocks.length}块）：\n${formatted}`,
        source: "candidateBlocks",
      };
    }

    return {
      payload: getSimplifiedHTML(),
      source: "fullHTML",
    };
  }

  // 使用AI分析页面结构（只识别题目，不返回答案）
  async function analyzePageWithAI() {
    const { payload, source } = buildAIAnalysisPayload();
    const contentIntro =
      source === "candidateBlocks"
        ? "本次提供的是经过前端筛选的疑似题目块，请基于这些块识别题目结构。"
        : "未找到足够的候选题目块，以下为整页精简HTML。";

    const prompt = `分析以下HTML页面，识别ALL题目的结构。

规则：
1. 检查HTML中每一个包含input[radio]/input[checkbox]/input[text]/textarea/select的元素
2. 每道题必须提取完整的题干文本（text字段），仔细找附近的文本节点
3. 如果题干在HTML中有点击展开、data属性、aria-label等，优先使用
4. 尽量找全所有题目，不要遗漏
5. 每道题必须包含：index, type, text
6. 单选/多选必须有options数组（每个option含label, text, selector）
7. 填空题必须有inputs数组（每个input含selector）
8. selector必须精确，能直接用document.querySelector定位
9. 【不要返回答案】，只识别结构

严格以下JSON格式返回，不要其他内容：
{
  "success": true,
  "questions": [
    {
      "index": 0,
      "type": "single",
      "text": "完整题干",
      "options": [{ "label": "A", "text": "选项", "selector": "精确CSS选择器" }]
    }
  ]
}

${contentIntro}

HTML内容：
${payload}`;

    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          action: "analyzeHTML",
          config,
          prompt,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          if (!response.success) {
            reject(new Error(response.error));
            return;
          }

          try {
            const result = parseAIResponse(response.data);
            resolve(result);
          } catch (e) {
            reject(new Error("解析AI响应失败: " + e.message));
          }
        }
      );
    });
  }

  // 使用AI分析结果创建题目列表（不含答案，答案在答题阶段逐题获取）
  function scanWithAISelectors(aiResult) {
    questions = [];
    answeredCount = 0;

    if (!aiResult.questions || aiResult.questions.length === 0) {
      return 0;
    }

    // 使用AI返回的题目结构数据（不含答案）
    aiResult.questions.forEach((q, index) => {
      const question = {
        index,
        type: q.type || "single",
        text: q.text || "",
        answer: null, // 答案在答题阶段获取
        explanation: null,
        options: [],
        inputs: [],
        answered: false,
      };

      // 处理选项（单选/多选题）
      if (q.options && q.options.length > 0) {
        question.options = q.options.map((opt) => ({
          label: opt.label,
          text: opt.text,
          selector: opt.selector,
          element: opt.selector ? safeQuerySelector(opt.selector) : null,
        }));
      }

      // 处理填空题输入框
      if (q.type === "fill" && q.inputs && q.inputs.length > 0) {
        question.inputs = q.inputs.map((inp) => ({
          selector: inp.selector,
          element: inp.selector ? safeQuerySelector(inp.selector) : null,
        }));
      }

      questions.push(question);
      console.log(
        `[AI答题助手] 题目${index + 1}:`,
        question.text.substring(0, 50)
      );
    });

    updateStats();
    return questions.length;
  }

  // 安全的querySelector，捕获无效选择器错误
  function safeQuerySelector(selector) {
    if (!selector) return null;
    try {
      return document.querySelector(selector);
    } catch (e) {
      console.warn("[AI答题助手] 无效的选择器:", selector, e);
      return null;
    }
  }

  // Remove duplicate questions
  function removeDuplicates(questions) {
    const seen = new Set();
    return questions.filter((q) => {
      const key = q.text.substring(0, 100);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Clean text
  function cleanText(text) {
    return text
      .replace(/\s+/g, " ")
      .replace(/[\r\n]+/g, " ")
      .trim()
      .substring(0, 1000);
  }

  // Start answering questions
  async function startAnswering() {
    if (isRunning) return;

    isRunning = true;

    if (questions.length === 0) {
      sendLog("warning", "请先扫描题目");
      isRunning = false;
      sendComplete();
      return;
    }

    sendLog("info", `开始答题，共 ${questions.length} 道题目`);

    for (let i = 0; i < questions.length; i++) {
      if (!isRunning) {
        sendLog("warning", "答题已停止");
        break;
      }

      const question = questions[i];

      if (question.answered) {
        continue;
      }

      // 找到第一个有效的选项元素用于滚动定位和高亮
      const firstElement = findFirstValidElement(question);

      if (firstElement) {
        // 滚动到题目位置
        scrollToElement(firstElement);
        await sleep(300);

        // 高亮当前题目区域
        const questionContainer = findQuestionContainer(firstElement);
        if (questionContainer) {
          highlightElement(questionContainer);
        }
      }

      sendLog(
        "info",
        `正在处理第 ${i + 1}/${questions.length} 题: ${question.text.substring(
          0,
          30
        )}...`
      );

      try {
        // 查记忆 → 命中直接复用
        const memHit = await lookupBank(question.text);
        let answer;
        if (memHit.hit) {
          answer = { type: memHit.type || question.type, answer: memHit.answer, explanation: memHit.explanation || "（题库复用）" };
          sendLog("success", `第 ${i + 1} 题命中题库 ✅ (已复用${memHit.count}次)`);
          saveAnswerHistory(question.text, memHit.answer, question.type, "题库");
        } else {
          sendLog("info", `正在获取第 ${i + 1} 题的答案...`);
          answer = await getAIAnswerForQuestion(question);
        }

        if (answer && answer.answer) {
          question.answer = answer.answer;
          question.explanation = answer.explanation;
          await applyAnswerDirectly(question);
          question.answered = true;
          answeredCount++;
          updateStats();
          // 存入题库（仅新题）并记入历史
          if (!memHit.hit) {
            saveToBank(question.text, answer.answer, question.type, answer.explanation);
            saveAnswerHistory(question.text, answer.answer, question.type, "AI");
          }
          // 发送统计
          chrome.runtime.sendMessage({
            action: "trackStats",
            event: "question_answered",
          });
          sendLog(
            "success",
            `第 ${i + 1} 题已完成，答案: ${JSON.stringify(question.answer)}`
          );
        } else {
          sendLog("warning", `第 ${i + 1} 题未能获取答案`);
        }
      } catch (error) {
        sendLog("error", `第 ${i + 1} 题处理失败: ${error.message}`);
        console.error("[AI答题助手] 答题错误:", error);
      }

      // 移除高亮
      if (firstElement) {
        const questionContainer = findQuestionContainer(firstElement);
        if (questionContainer) {
          removeHighlight(questionContainer);
          // 添加已完成标记
          markAsCompleted(questionContainer);
        }
      }

      // Wait before next question
      await sleep(500);
    }

    isRunning = false;
    sendComplete();
  }

  // 找到题目中第一个有效的元素用于定位
  function findFirstValidElement(question) {
    if (question.options && question.options.length > 0) {
      for (const opt of question.options) {
        if (opt.element) return opt.element;
        // 尝试重新查询
        if (opt.selector) {
          const el = safeQuerySelector(opt.selector);
          if (el) return el;
        }
      }
    }
    if (question.inputs && question.inputs.length > 0) {
      for (const inp of question.inputs) {
        if (inp.element) return inp.element;
        if (inp.selector) {
          const el = safeQuerySelector(inp.selector);
          if (el) return el;
        }
      }
    }
    return null;
  }

  // 根据选项元素向上查找题目容器（精确定位到单道题）
  function findQuestionContainer(element) {
    if (!element) return null;

    // 优先使用腾讯问卷的精确容器选择器
    const tencentContainer = element.closest(
      "section.question[data-question-id]"
    );
    if (tencentContainer) {
      return tencentContainer;
    }

    // 先找到这个选项所属的所有同级选项（同一道题的选项）
    const elementInput =
      element.tagName === "INPUT" ? element : element.querySelector("input");
    const inputName = elementInput?.name;

    let current = element.parentElement;
    let bestContainer = null;
    let depth = 0;
    const maxDepth = 4; // 限制层数，只找最近的容器

    while (current && current !== document.body && depth < maxDepth) {
      // 检查当前容器内有多少组选项（通过不同的 name 判断）
      const allInputs = current.querySelectorAll(
        'input[type="radio"], input[type="checkbox"]'
      );
      const names = new Set();
      allInputs.forEach((inp) => {
        if (inp.name) names.add(inp.name);
      });

      // 如果这个容器只包含一道题的选项（1个name），就是我们要的
      if (names.size === 1 && allInputs.length >= 2) {
        bestContainer = current;
        // 继续向上找一层，看看父元素是否也只包含这一道题
        // 但不要找太多层
      } else if (names.size > 1) {
        // 包含多道题了，停止，使用上一个找到的容器
        break;
      }

      // 如果没有 input，检查是否有可点击的选项元素
      if (allInputs.length === 0) {
        const options = current.querySelectorAll(
          '.option, [class*="option"], [class*="choice"]'
        );
        if (options.length >= 2 && options.length <= 6) {
          bestContainer = current;
        }
      }

      current = current.parentElement;
      depth++;
    }

    // 如果没找到，返回选项的直接父元素的父元素
    return (
      bestContainer ||
      element.parentElement?.parentElement ||
      element.parentElement ||
      element
    );
  }

  // 标记题目为已完成
  function markAsCompleted(element) {
    if (!element) return;

    // 添加完成样式
    // 检查是否已有标记
    if (element.dataset.aiAnswerCompleted === "true") return;

    // 创建完成标记
    removeHighlight(element);
    element.dataset.aiAnswerCompleted = "true";
    element.style.outline = "2px solid #22c55e";
    element.style.outlineOffset = "2px";
  }

  // 直接应用答案（使用AI返回的选择器）
  async function applyAnswerDirectly(question) {
    console.log("[AI答题助手] applyAnswerDirectly type=" + question.type + " text=" + (question.text||"").substring(0,30));
    switch (question.type) {
      case "single":
      case "judge":
      case "select":
        await applySingleAnswerDirectly(question);
        break;
      case "multiple":
        await applyMultipleAnswerDirectly(question);
        break;
      case "fill":
        await applyFillAnswerDirectly(question);
        break;
    }
  }

  // 单选题 - 直接点击对应选项
  async function applySingleAnswerDirectly(question) {
    console.log("[AI答题助手] applySingleAnswerDirectly type=" + question.type + " answer=" + question.answer + " options=" + (question.options||[]).length);
    const answerLetter = String(question.answer).toUpperCase();

    // 下拉选择框（select）
    if (question.selectElement) {
      for (const option of question.options) {
        if (option.label.toUpperCase() === answerLetter) {
          question.selectElement.value = option.value;
          question.selectElement.dispatchEvent(new Event("change", { bubbles: true }));
          console.log(`[AI答题助手] 下拉已选择: ${option.label} (${option.value})`);
          return;
        }
      }
    }

    for (const option of question.options) {
      // 匹配字母或文字（如判断题AI可能返回"正确"而非"A"）
      const matches = option.label.toUpperCase() === answerLetter ||
        option.text.includes(answerLetter) ||
        answerLetter.includes(option.text.replace(/\s+/g, ""));
      if (matches) {
        // 优先使用已解析的element
        let element = option.element;

        // 如果element无效，尝试重新查询
        if (!element && option.selector) {
          element = safeQuerySelector(option.selector);
        }

        if (element) {
          await clickElement(element);
          console.log(`[AI答题助手] 单选已点击: ${option.label}`);
        } else {
          console.warn(
            `[AI答题助手] 找不到选项元素: ${option.label}, selector: ${option.selector}`
          );
        }
        break;
      }
    }
  }

  // 多选题 - 点击所有正确选项
  async function applyMultipleAnswerDirectly(question) {
    let answers = question.answer;

    // 确保answers是数组
    if (typeof answers === "string") {
      answers = answers
        .split("")
        .filter((c) => /[A-Z]/i.test(c))
        .map((c) => c.toUpperCase());
    } else if (Array.isArray(answers)) {
      answers = answers.map((a) => String(a).toUpperCase());
    }

    console.log(`[AI答题助手] 多选答案:`, answers);

    for (const option of question.options) {
      if (answers.includes(option.label.toUpperCase())) {
        let element = option.element;

        if (!element && option.selector) {
          element = safeQuerySelector(option.selector);
        }

        if (element) {
          await clickElement(element);
          console.log(`[AI答题助手] 多选已点击: ${option.label}`);
          await sleep(200);
        } else {
          console.warn(
            `[AI答题助手] 找不到选项元素: ${option.label}, selector: ${option.selector}`
          );
        }
      }
    }
  }

  // 填空题 - 填写答案
  async function applyFillAnswerDirectly(question) {
    let answers = question.answer;

    // 确保answers是数组
    if (!Array.isArray(answers)) {
      answers = [answers];
    }

    // 获取第一个输入框
    let inputElement = null;

    for (const inputInfo of question.inputs) {
      let element = inputInfo.element;
      if (!element && inputInfo.selector) {
        element = safeQuerySelector(inputInfo.selector);
      }
      if (element) {
        inputElement = element;
        break;
      }
    }

    if (!inputElement) {
      console.warn(`[AI答题助手] 找不到填空题输入框`);
      return;
    }

    // 将所有答案合并为一个字符串填入同一个输入框
    // 如果只有一个答案，直接使用；多个答案用中文分号 "；" 分隔
    const combinedAnswer =
      answers.length === 1
        ? String(answers[0])
        : answers.map((a) => String(a)).join("；");

    await fillInput(inputElement, combinedAnswer);
    console.log(`[AI答题助手] 填空已填写: ${combinedAnswer}`);
  }

  // 填写输入框
  async function fillInput(element, value) {
    element.focus();
    await sleep(50);

    // 清空现有值
    element.value = "";

    // 设置新值
    element.value = value;

    // 触发各种事件确保框架能检测到变化
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));

    element.blur();
  }

  // Stop answering
  function stopAnswering() {
    isRunning = false;
  }

  // 逐题获取AI答案（只发送单道题目，不发送整页HTML）
  async function getAIAnswerForQuestion(question) {
    let prompt = `请回答以下${getTypeLabel(question.type)}：\n\n`;
    prompt += `题目：${question.text}\n\n`;

    if (question.options && question.options.length > 0) {
      prompt += "选项：\n";
      question.options.forEach((opt) => {
        prompt += `${opt.label}. ${opt.text}\n`;
      });
      prompt += "\n";
    }

    if (
      question.type === "fill" &&
      question.inputs &&
      question.inputs.length > 1
    ) {
      prompt += `（共有 ${question.inputs.length} 个空需要填写）\n\n`;
    }

    prompt += `请严格按照JSON格式返回答案：
{
  "type": "${question.type}",
  "answer": ${
    question.type === "single"
      ? '"选项字母如B"'
      : question.type === "multiple"
      ? '["A", "C"]'
      : '["答案1", "答案2"]'
  },
  "explanation": "简短解释"
}

注意：
- 单选题answer为单个字母，如 "B"
- 多选题answer为字母数组，如 ["A", "C"]
- 填空题answer为答案数组，如 ["答案1"] 或 ["答案1", "答案2"]
- 只返回JSON，不要其他内容`;

    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          action: "callAI",
          config,
          prompt,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          if (!response.success) {
            reject(new Error(response.error));
            return;
          }

          try {
            const answer = parseAIResponse(response.data);
            resolve(answer);
          } catch (e) {
            reject(new Error("解析AI响应失败: " + e.message));
          }
        }
      );
    });
  }

  // Get AI answer for a question (legacy, kept for compatibility)
  async function getAIAnswer(question) {
    return getAIAnswerForQuestion(question);
  }

  // Build prompt for AI
  function buildPrompt(question) {
    let prompt = `题目类型: ${getTypeLabel(question.type)}\n\n`;
    prompt += `题目: ${question.text}\n\n`;

    if (question.options.length > 0) {
      prompt += "选项:\n";
      question.options.forEach((opt) => {
        prompt += `${opt.label}. ${opt.text}\n`;
      });
    }

    if (question.type === "fill") {
      prompt += `\n这是一道填空题，请给出填空的答案。`;
      if (question.inputs.length > 1) {
        prompt += `共有 ${question.inputs.length} 个空需要填写。`;
      }
    }

    return prompt;
  }

  // Get type label
  function getTypeLabel(type) {
    const labels = {
      single: "单选题",
      multiple: "多选题",
      judge: "判断题",
      fill: "填空题",
      select: "下拉题",
    };
    return labels[type] || type;
  }

  // Parse AI response
  function parseAIResponse(responseText) {
    if (!responseText || typeof responseText !== "string") {
      throw new Error("AI返回内容为空");
    }
    let jsonStr = responseText;

    // Handle markdown code blocks
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }

    // Try to find JSON object or array
    const objMatch = jsonStr.match(/\{[\s\S]*\}/) || jsonStr.match(/\[[\s\S]*\]/);
    if (objMatch) {
      jsonStr = objMatch[0];
    }

    // Attempt 1: direct parse
    try { const p = JSON.parse(jsonStr); if (p && (p.answer || p.questions || Array.isArray(p))) return p; } catch(e) {}

    // Attempt 2: fix trailing commas, unquoted keys
    try {
      const fixed = jsonStr
        .replace(/,\s*}/g, "}")
        .replace(/,\s*\]/g, "]")
        .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?\s*:/g, '"$2":');
      return JSON.parse(fixed);
    } catch(e) {}

    // Attempt 3: extract answer via regex (single question fallback)
    const ansMatch = jsonStr.match(/"answer"\s*:\s*"([^"]+)"/);
    if (ansMatch) return { type: "single", answer: ansMatch[1], explanation: "(原始响应提取)" };

    throw new Error("无法解析AI响应: " + responseText.substring(0, 200));
  }

  // Apply answer to question
  async function applyAnswer(question, answer) {
    switch (question.type) {
      case "single":
        await applySingleAnswer(question, answer);
        break;
      case "multiple":
        await applyMultipleAnswer(question, answer);
        break;
      case "fill":
        await applyFillAnswer(question, answer);
        break;
    }
  }

  // Apply single choice answer
  async function applySingleAnswer(question, answer) {
    const answerLetter = String(answer.answer).toUpperCase();

    for (const option of question.options) {
      if (option.label === answerLetter) {
        await clickElement(option.element);
        break;
      }
    }
  }

  // Apply multiple choice answer
  async function applyMultipleAnswer(question, answer) {
    let answers = answer.answer;
    if (typeof answers === "string") {
      answers = answers.split("").filter((c) => /[A-Z]/.test(c));
    }

    for (const option of question.options) {
      if (answers.includes(option.label)) {
        await clickElement(option.element);
        await sleep(200);
      }
    }
  }

  // Apply fill-in-the-blank answer
  async function applyFillAnswer(question, answer) {
    let answers = answer.answer;
    if (!Array.isArray(answers)) {
      answers = [answers];
    }

    for (let i = 0; i < Math.min(answers.length, question.inputs.length); i++) {
      const input = question.inputs[i];
      const value = String(answers[i]);

      // Focus and fill
      input.focus();
      await sleep(100);

      // Clear existing value
      input.value = "";

      // Set new value
      input.value = value;

      // Trigger events
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));

      await sleep(100);
    }
  }

  // Click element - 增强版，支持多种点击方式
  async function clickElement(element) {
    if (!element) {
      console.warn("[AI答题助手] clickElement: element为空");
      return;
    }

    console.log("[AI答题助手] 点击元素:", element.tagName, element.className);

    // 1. 如果是input元素（radio/checkbox）
    if (element.tagName === "INPUT") {
      const inputType = element.type?.toLowerCase();
      if (inputType === "radio" || inputType === "checkbox") {
        // 优先尝试点击关联的label
        if (element.id) {
          const label = document.querySelector(`label[for="${element.id}"]`);
          if (label) {
            console.log("[AI答题助手] 找到关联label，点击label");
            // 直接点击label（标准HTML行为）
            label.click();
            await sleep(100);
            if (element.checked) {
              console.log("[AI答题助手] 通过label点击成功");
              return;
            }
            // label点击无效，用MouseEvent完整模拟
            label.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            label.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            label.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            await sleep(100);
            if (element.checked) {
              console.log("[AI答题助手] 通过MouseEvent点击成功");
              return;
            }
            // 直接触发input上的click
            element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
            element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            await sleep(50);
            if (element.checked) {
              console.log("[AI答题助手] 通过input MouseEvent点击成功");
              return;
            }
          }
        }

        // Ant Design: 点击 wrapper 触发 React 事件（input 隐藏时必需）
        if (!element.checked) {
          const adWrapper = element.closest('.ant-checkbox-wrapper, .ant-radio-wrapper');
          if (adWrapper) {
            console.log("[AI答题助手] 找到Ant Design wrapper，点击wrapper");
            adWrapper.click();
            await sleep(80);
            if (element.checked) {
              console.log("[AI答题助手] 通过wrapper点击成功");
              return;
            }
          }
        }

        // 章节测试: 点击父级 li 触发事件
        if (!element.checked) {
          const parentLi = element.closest('li.f-cb');
          if (parentLi) {
            console.log("[AI答题助手] 点击父级li, id=" + element.id + " label=" + (document.querySelector('label[for="' + element.id + '"]') ? 'found' : 'not found'));
            // 依次尝试 li 本身和里面的 label
            parentLi.click();
            await sleep(50);
            if (element.checked) {
              console.log("[AI答题助手] 通过li点击成功");
              return;
            }
            console.log("[AI答题助手] li点击后element.checked=" + element.checked);
            // 尝试 li 内的 label
            const liLabel = parentLi.querySelector('label[for]');
            if (liLabel) {
              console.log("[AI答题助手] 点击li内的label");
              liLabel.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
              await sleep(50);
              if (element.checked) {
                console.log("[AI答题助手] 通过li内label点击成功");
                return;
              }
              console.log("[AI答题助手] li内label点击后element.checked=" + element.checked);
            }
          }
        }

        // 兜底：直接设置checked
        element.checked = true;
      }
      element.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    // 2. 查找内部的input元素
    const input = element.querySelector(
      'input[type="radio"], input[type="checkbox"]'
    );
    if (input) {
      input.checked = true;
      input.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // 3. 点击元素本身
    element.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
      })
    );

    // 4. 尝试直接调用click方法
    if (typeof element.click === "function") {
      element.click();
    }

    // 5. 对于某些框架，可能需要触发mousedown/mouseup
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await sleep(50);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }

  // Scroll to element
  function scrollToElement(element) {
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // Highlight element - 高亮当前正在处理的题目（绿色流动光效）
  function highlightElement(element) {
    if (!element) return;

    // 保存原始样式
    element.dataset.originalOutline = element.style.outline || "";
    element.dataset.originalOutlineOffset = element.style.outlineOffset || "";
    element.dataset.originalBoxShadow = element.style.boxShadow || "";
    element.dataset.originalPosition = element.style.position || "";

    // 确保元素有定位以便添加伪元素
    if (getComputedStyle(element).position === "static") {
      element.style.position = "relative";
    }

    // 添加流动光效样式（如果还没添加）
    if (!document.getElementById("ai-answer-highlight-style")) {
      const style = document.createElement("style");
      style.id = "ai-answer-highlight-style";
      style.textContent = `
        @keyframes ai-border-flow {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        .ai-answer-processing {
          position: relative !important;
        }
        .ai-answer-processing::before {
          content: '';
          position: absolute;
          top: -3px;
          left: -3px;
          right: -3px;
          bottom: -3px;
          background: linear-gradient(90deg, #3b82f6, #6366f1, #8b5cf6, #6366f1, #3b82f6);
          background-size: 300% 100%;
          border-radius: 8px;
          z-index: -1;
          animation: ai-border-flow 2s ease infinite;
        }
        .ai-answer-processing::after {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: white;
          border-radius: 6px;
          z-index: -1;
        }
      `;
      document.head.appendChild(style);
    }

    // 应用高亮样式
    element.style.boxShadow = "0 0 20px rgba(59, 130, 246, 0.5)";
    element.style.transition = "all 0.3s ease";
    element.style.zIndex = "1";

    // 添加动画类
    element.classList.add("ai-answer-processing");
  }

  // Remove highlight - 移除高亮
  function removeHighlight(element) {
    if (!element) return;

    // 恢复原始样式
    element.style.outline = element.dataset.originalOutline || "";
    element.style.outlineOffset = element.dataset.originalOutlineOffset || "";
    element.style.boxShadow = element.dataset.originalBoxShadow || "";
    element.style.position = element.dataset.originalPosition || "";
    element.style.zIndex = "";

    // 移除动画类
    element.classList.remove("ai-answer-processing");
  }

  // Send log to popup
  function sendLog(level, text) {
    chrome.runtime.sendMessage({ type: "log", level, text });
  }

  // Update stats in popup
  function updateStats() {
    chrome.runtime.sendMessage({
      type: "updateStats",
      questionCount: questions.length,
      answeredCount,
    });
  }

  // Send complete message
  function sendComplete() {
    chrome.runtime.sendMessage({ type: "complete", answeredCount });
  }

  // Sleep utility
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Initialize
  console.log("AI自动答题助手已加载");

  // 初始化模板系统
  if (window.templateManager) {
    window.templateManager
      .init()
      .then(() => {
        console.log("模板系统初始化完成");
      })
      .catch((error) => {
        console.error("模板系统初始化失败:", error);
      });
  }
})();
