// 配置
const CONFIG = {
  API_KEY: "090809080908",  // 該API的對外驗證key
  CF_ACCOUNT_LIST: [{ account_id: "你的cloudflare帳號", token: "你的cloudflare API TOKEN" }],  // 換成自己的,可以多個號隨機調用
  CF_IS_TRANSLATE: true,  // 是否啟用提示詞AI翻譯及優化,關閉後將會把提示詞直接發送給繪圖模型
  CF_TRANSLATE_MODEL: "@cf/qwen/qwen1.5-14b-chat-awq",  // 使用的cf ai模型
  USE_EXTERNAL_API: false, // 是否使用自定義API,開啟後將使用外部模型生成提示詞,需要填寫下面三項
  EXTERNAL_API: "", //自定義API地址,例如:https://xxx.com/v1/chat/completions
  EXTERNAL_MODEL: "", // 模型名稱,例如:gpt-4o
  EXTERNAL_API_KEY: "", // API密鑰
  FLUX_NUM_STEPS: 4, // Flux模型的num_steps參數,範圍：4-8
  CUSTOMER_MODEL_MAP: {
//    "SD-1.5-Inpainting-CF": "@cf/runwayml/stable-diffusion-v1-5-inpainting",  // 不知道是哪里有問題,先禁用了
    "DS-8-CF": "@cf/lykon/dreamshaper-8-lcm",
    "SD-XL-Bash-CF": "@cf/stabilityai/stable-diffusion-xl-base-1.0",
    "SD-XL-Lightning-CF": "@cf/bytedance/stable-diffusion-xl-lightning",
    "FLUX.1-Schnell-CF": "@cf/black-forest-labs/flux-1-schnell"
  },
  IMAGE_EXPIRATION: 60 * 30 // 圖片在 KV 中的過期時間（秒），這里設置為 30 分鐘
};

// 主處理函數
async function handleRequest(request) {
  if (request.method === "OPTIONS") {
    return handleCORS();
  }

  if (!isAuthorized(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  if (url.pathname.endsWith("/v1/models")) {
    return handleModelsRequest();
  }

  if (request.method !== "POST" || !url.pathname.endsWith("/v1/chat/completions")) {
    return new Response("Not Found", { status: 404 });
  }

  return handleChatCompletions(request);
}

// 處理CORS預檢請求
function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}

// 驗證授權
function isAuthorized(request) {
  const authHeader = request.headers.get("Authorization");
  return authHeader && authHeader.startsWith("Bearer ") && authHeader.split(" ")[1] === CONFIG.API_KEY;
}

// 處理模型列表請求
function handleModelsRequest() {
  const models = Object.keys(CONFIG.CUSTOMER_MODEL_MAP).map(id => ({ id, object: "model" }));
  return new Response(JSON.stringify({ data: models, object: "list" }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// 處理聊天完成請求
async function handleChatCompletions(request) {
  try {
    const data = await request.json();
    const { messages, model: requestedModel, stream } = data;
    // 確保獲取最新的用戶消息
    const userMessage = messages.findLast(msg => msg.role === "user")?.content;
    // const userMessage = messages.find(msg => msg.role === "user")?.content;

    if (!userMessage) {
      return new Response(JSON.stringify({ error: "未找到用戶消息" }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const isTranslate = extractTranslate(userMessage);
    const originalPrompt = cleanPromptString(userMessage);
    const model = CONFIG.CUSTOMER_MODEL_MAP[requestedModel] || CONFIG.CUSTOMER_MODEL_MAP["SD-XL-Lightning-CF"];

    // 確定使用哪個模型生成提示詞
    const promptModel = determinePromptModel();

    const translatedPrompt = isTranslate ? 
      (model === CONFIG.CUSTOMER_MODEL_MAP["FLUX.1-Schnell-CF"] ? 
        await getFluxPrompt(originalPrompt, promptModel) : 
        await getPrompt(originalPrompt, promptModel)) : 
      originalPrompt;

    const imageUrl = model === CONFIG.CUSTOMER_MODEL_MAP["FLUX.1-Schnell-CF"] ?
      await generateAndStoreFluxImage(model, translatedPrompt, request.url) :
      await generateAndStoreImage(model, translatedPrompt, request.url);

    return stream ? 
      handleStreamResponse(originalPrompt, translatedPrompt, "1024x1024", model, imageUrl, promptModel) :
      handleNonStreamResponse(originalPrompt, translatedPrompt, "1024x1024", model, imageUrl, promptModel);
  } catch (error) {
    return new Response(JSON.stringify({ error: "Internal Server Error: " + error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

function determinePromptModel() {
  return (CONFIG.USE_EXTERNAL_API && CONFIG.EXTERNAL_API && CONFIG.EXTERNAL_MODEL && CONFIG.EXTERNAL_API_KEY) ?
    CONFIG.EXTERNAL_MODEL : CONFIG.CF_TRANSLATE_MODEL;
}

// 獲取翻譯後的提示詞
async function getPrompt(prompt, model) {
  const requestBody = {
    messages: [
      {
        role: "system",
        content: `作為 Stable Diffusion Prompt 提示詞專家，您將從關鍵詞中創建提示，通常來自 Danbooru 等數據庫。

        提示通常描述圖像，使用常見詞匯，按重要性排列，並用逗號分隔。避免使用"-"或"."，但可以接受空格和自然語言。避免詞匯重覆。

        為了強調關鍵詞，請將其放在括號中以增加其權重。例如，"(flowers)"將'flowers'的權重增加1.1倍，而"(((flowers)))"將其增加1.331倍。使用"(flowers:1.5)"將'flowers'的權重增加1.5倍。只為重要的標簽增加權重。

        提示包括三個部分：**前綴** （質量標簽+風格詞+效果器）+ **主題** （圖像的主要焦點）+ **場景** （背景、環境）。

        *   前綴影響圖像質量。像"masterpiece"、"best quality"、"4k"這樣的標簽可以提高圖像的細節。像"illustration"、"lensflare"這樣的風格詞定義圖像的風格。像"bestlighting"、"lensflare"、"depthoffield"這樣的效果器會影響光照和深度。

        *   主題是圖像的主要焦點，如角色或場景。對主題進行詳細描述可以確保圖像豐富而詳細。增加主題的權重以增強其清晰度。對於角色，描述面部、頭發、身體、服裝、姿勢等特征。

        *   場景描述環境。沒有場景，圖像的背景是平淡的，主題顯得過大。某些主題本身包含場景（例如建築物、風景）。像"花草草地"、"陽光"、"河流"這樣的環境詞可以豐富場景。你的任務是設計圖像生成的提示。請按照以下步驟進行操作：

        1.  我會發送給您一個圖像場景。需要你生成詳細的圖像描述
        2.  圖像描述必須是英文，輸出為Positive Prompt。

        示例：

        我發送：二戰時期的護士。
        您回覆只回覆：
        A WWII-era nurse in a German uniform, holding a wine bottle and stethoscope, sitting at a table in white attire, with a table in the background, masterpiece, best quality, 4k, illustration style, best lighting, depth of field, detailed character, detailed environment.`
      },
      { role: "user", content: prompt }
    ],
    model: CONFIG.EXTERNAL_MODEL
  };

  if (model === CONFIG.EXTERNAL_MODEL) {
    return await getExternalPrompt(requestBody);
  } else {
    return await getCloudflarePrompt(CONFIG.CF_TRANSLATE_MODEL, requestBody);
  }
}

// 獲取 Flux 模型的翻譯後的提示詞
async function getFluxPrompt(prompt, model) {
  const requestBody = {
    messages: [
      {
        role: "system",
        content: `你是一個基於Flux.1模型的提示詞生成機器人。根據用戶的需求，自動生成符合Flux.1格式的繪畫提示詞。雖然你可以參考提供的模板來學習提示詞結構和規律，但你必須具備靈活性來應對各種不同需求。最終輸出應僅限提示詞，無需任何其他解釋或信息。你的回答必須全部使用英語進行回覆我！

### **提示詞生成邏輯**：

1. **需求解析**：從用戶的描述中提取關鍵信息，包括：
   - 角色：外貌、動作、表情等。
   - 場景：環境、光線、天氣等。
   - 風格：藝術風格、情感氛圍、配色等。
   - 其他元素：特定物品、背景或特效。

2. **提示詞結構規律**：
   - **簡潔、精確且具象**：提示詞需要簡單、清晰地描述核心對象，並包含足夠細節以引導生成出符合需求的圖像。
   - **靈活多樣**：參考下列模板和已有示例，但需根據具體需求生成多樣化的提示詞，避免固定化或過於依賴模板。
   - **符合Flux.1風格的描述**：提示詞必須遵循Flux.1的要求，盡量包含藝術風格、視覺效果、情感氛圍的描述，使用與Flux.1模型生成相符的關鍵詞和描述模式。

3. **僅供你參考和學習的幾種場景提示詞**（你需要學習並靈活調整,"[ ]"中內容視用戶問題而定）：
   - **角色表情集**：
場景說明：適合動畫或漫畫創作者為角色設計多樣的表情。這些提示詞可以生成展示同一角色在不同情緒下的表情集，涵蓋快樂、悲傷、憤怒等多種情感。

提示詞：An anime [SUBJECT], animated expression reference sheet, character design, reference sheet, turnaround, lofi style, soft colors, gentle natural linework, key art, range of emotions, happy sad mad scared nervous embarrassed confused neutral, hand drawn, award winning anime, fully clothed

[SUBJECT] character, animation expression reference sheet with several good animation expressions featuring the same character in each one, showing different faces from the same person in a grid pattern: happy sad mad scared nervous embarrassed confused neutral, super minimalist cartoon style flat muted kawaii pastel color palette, soft dreamy backgrounds, cute round character designs, minimalist facial features, retro-futuristic elements, kawaii style, space themes, gentle line work, slightly muted tones, simple geometric shapes, subtle gradients, oversized clothing on characters, whimsical, soft puffy art, pastels, watercolor

   - **全角度角色視圖**：
場景說明：當需要從現有角色設計中生成不同角度的全身圖時，如正面、側面和背面，適用於角色設計細化或動畫建模。

提示詞：A character sheet of [SUBJECT] in different poses and angles, including front view, side view, and back view

   - **80 年代覆古風格**：
場景說明：適合希望創造 80 年代覆古風格照片效果的藝術家或設計師。這些提示詞可以生成帶有懷舊感的模糊寶麗來風格照片。

提示詞：blurry polaroid of [a simple description of the scene], 1980s.

   - **智能手機內部展示**：
場景說明：適合需要展示智能手機等產品設計的科技博客作者或產品設計師。這些提示詞幫助生成展示手機外觀和屏幕內容的圖像。

提示詞：a iphone product image showing the iphone standing and inside the screen the image is shown

   - **雙重曝光效果**：
場景說明：適合攝影師或視覺藝術家通過雙重曝光技術創造深度和情感表達的藝術作品。

提示詞：[Abstract style waterfalls, wildlife] inside the silhouette of a [man]’s head that is a double exposure photograph . Non-representational, colors and shapes, expression of feelings, imaginative, highly detailed

   - **高質感電影海報**：
場景說明：適合需要為電影創建引人注目海報的電影宣傳或平面設計師。

提示詞：A digital illustration of a movie poster titled [‘Sad Sax: Fury Toad’], [Mad Max] parody poster, featuring [a saxophone-playing toad in a post-apocalyptic desert, with a customized car made of musical instruments], in the background, [a wasteland with other musical vehicle chases], movie title in [a gritty, bold font, dusty and intense color palette].

   - **鏡面自拍效果**：
場景說明：適合想要捕捉日常生活瞬間的攝影師或社交媒體用戶。

提示詞：Phone photo: A woman stands in front of a mirror, capturing a selfie. The image quality is grainy, with a slight blur softening the details. The lighting is dim, casting shadows that obscure her features. [The room is cluttered, with clothes strewn across the bed and an unmade blanket. Her expression is casual, full of concentration], while the old iPhone struggles to focus, giving the photo an authentic, unpolished feel. The mirror shows smudges and fingerprints, adding to the raw, everyday atmosphere of the scene.

   - **像素藝術創作**：
場景說明：適合像素藝術愛好者或覆古遊戲開發者創造或覆刻經典像素風格圖像。

提示詞：[Anything you want] pixel art style, pixels, pixel art

   - **以上部分場景僅供你學習，一定要學會靈活變通，以適應任何繪畫需求**：

4. **Flux.1提示詞要點總結**：
   - **簡潔精準的主體描述**：明確圖像中核心對象的身份或場景。
   - **風格和情感氛圍的具體描述**：確保提示詞包含藝術風格、光線、配色、以及圖像的氛圍等信息。
   - **動態與細節的補充**：提示詞可包括場景中的動作、情緒、或光影效果等重要細節。
   - **其他更多規律請自己尋找**
---

**問答案例1**：
**用戶輸入**：一個80年代覆古風格的照片。
**你的輸出**：A blurry polaroid of a 1980s living room, with vintage furniture, soft pastel tones, and a nostalgic, grainy texture,  The sunlight filters through old curtains, casting long, warm shadows on the wooden floor, 1980s,

**問答案例2**：
**用戶輸入**：一個賽博朋克風格的夜晚城市背景
**你的輸出**：A futuristic cityscape at night, in a cyberpunk style, with neon lights reflecting off wet streets, towering skyscrapers, and a glowing, high-tech atmosphere. Dark shadows contrast with vibrant neon signs, creating a dramatic, dystopian mood`
      },
      { role: "user", content: prompt }
    ],
    model: CONFIG.EXTERNAL_MODEL
  };

  if (model === CONFIG.EXTERNAL_MODEL) {
    return await getExternalPrompt(requestBody);
  } else {
    return await getCloudflarePrompt(CONFIG.CF_TRANSLATE_MODEL, requestBody);
  }
}

// 從外部API獲取提示詞
async function getExternalPrompt(requestBody) {
  try {
    const response = await fetch(CONFIG.EXTERNAL_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.EXTERNAL_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      throw new Error(`External API request failed with status ${response.status}`);
    }

    const jsonResponse = await response.json();
    if (!jsonResponse.choices || jsonResponse.choices.length === 0 || !jsonResponse.choices[0].message) {
      throw new Error('Invalid response format from external API');
    }

    return jsonResponse.choices[0].message.content;
  } catch (error) {
    console.error('Error in getExternalPrompt:', error);
 // 如果外部API失敗，回退到使用原始提示詞
    return requestBody.messages[1].content;
  }
}

// 從Cloudflare獲取提示詞
async function getCloudflarePrompt(model, requestBody) {
  const response = await postRequest(model, requestBody);
  if (!response.ok) return requestBody.messages[1].content;

  const jsonResponse = await response.json();
  return jsonResponse.result.response;
}

// 生成圖像並存儲到 KV
async function generateAndStoreImage(model, prompt, requestUrl) {
  try {
    const jsonBody = { prompt, num_steps: 20, guidance: 7.5, strength: 1, width: 1024, height: 1024 };
    const response = await postRequest(model, jsonBody);
    const imageBuffer = await response.arrayBuffer();

    const key = `image_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    
    await IMAGE_KV.put(key, imageBuffer, {
      expirationTtl: CONFIG.IMAGE_EXPIRATION,
      metadata: { contentType: 'image/png' }
    });

    return `${new URL(requestUrl).origin}/image/${key}`;
  } catch (error) {
    throw new Error("圖像生成失敗: " + error.message);
  }
}

// 使用 Flux 模型生成並存儲圖像
async function generateAndStoreFluxImage(model, prompt, requestUrl) {
  try {
    const jsonBody = { prompt, num_steps: CONFIG.FLUX_NUM_STEPS };
    const response = await postRequest(model, jsonBody);
    const jsonResponse = await response.json();
    const base64ImageData = jsonResponse.result.image;

    const imageBuffer = base64ToArrayBuffer(base64ImageData);

    const key = `image_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    await IMAGE_KV.put(key, imageBuffer, {
      expirationTtl: CONFIG.IMAGE_EXPIRATION,
      metadata: { contentType: 'image/png' }
    });

    return `${new URL(requestUrl).origin}/image/${key}`;
  } catch (error) {
    throw new Error("Flux圖像生成失敗: " + error.message);
  }
}

// 處理流式響應
function handleStreamResponse(originalPrompt, translatedPrompt, size, model, imageUrl, promptModel) {
  const content = generateResponseContent(originalPrompt, translatedPrompt, size, model, imageUrl, promptModel);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{ delta: { content: content }, index: 0, finish_reason: null }]
      })}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",  // 確保每次回應不被緩存
      'Access-Control-Allow-Origin': '*',
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    }
  });
}

// 處理非流式響應
function handleNonStreamResponse(originalPrompt, translatedPrompt, size, model, imageUrl, promptModel) {
  const content = generateResponseContent(originalPrompt, translatedPrompt, size, model, imageUrl, promptModel);
  const response = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop"
    }],
    usage: {
      prompt_tokens: translatedPrompt.length,
      completion_tokens: content.length,
      total_tokens: translatedPrompt.length + content.length
    }
  };

  return new Response(JSON.stringify(response), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// 生成響應內容
function generateResponseContent(originalPrompt, translatedPrompt, size, model, imageUrl, promptModel) {
  return `🎨 原始提示詞：${originalPrompt}\n` +
         `💬 提示詞生成模型：${promptModel}\n` +
         `🌐 翻譯後的提示詞：${translatedPrompt}\n` +
         `📐 圖像規格：${size}\n` +
         `🖼️ 繪圖模型：${model}\n` +
         `🌟 圖像生成成功！\n` +
         `以下是結果：\n\n` +
         `![生成的圖像](${imageUrl})`;
}

// 發送POST請求
async function postRequest(model, jsonBody) {
  const cf_account = CONFIG.CF_ACCOUNT_LIST[Math.floor(Math.random() * CONFIG.CF_ACCOUNT_LIST.length)];
  const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${cf_account.account_id}/ai/run/${model}`;
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cf_account.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(jsonBody)
  });

  if (!response.ok) {
    throw new Error('Cloudflare API request failed: ' + response.status);
  }
  return response;
}

// 提取翻譯標志
function extractTranslate(prompt) {
  const match = prompt.match(/---n?tl/);
  return match ? match[0] === "---tl" : CONFIG.CF_IS_TRANSLATE;
}

// 清理提示詞字符串
function cleanPromptString(prompt) {
  return prompt.replace(/---n?tl/, "").trim();
}

// 處理圖片請求
async function handleImageRequest(request) {
  const url = new URL(request.url);
  const key = url.pathname.split('/').pop();
  
  const imageData = await IMAGE_KV.get(key, 'arrayBuffer');
  if (!imageData) {
    return new Response('Image not found', { status: 404 });
  }

  return new Response(imageData, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=604800',
    },
  });
}

// base64 字符串轉換為 ArrayBuffer
function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/image/')) {
    event.respondWith(handleImageRequest(event.request));
  } else {
    event.respondWith(handleRequest(event.request));
  }
});
