const TelegramBot = require("node-telegram-bot-api");
require("dotenv").config();
const Tesseract = require("tesseract.js");
const fs = require("fs");
const https = require("https");
const path = require("path");
const http = require("http");

// ==================== CONFIGURATION ====================
const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENROUTER_KEY = process.env.OPENROUTER_KEY;

if (!BOT_TOKEN || !OPENROUTER_KEY) {
    console.error("❌ .env faylida TELEGRAM_TOKEN va OPENROUTER_KEY borligini tekshiring.");
    process.exit(1);
}

// ==================== UTILITY FUNCTIONS ====================

/**
 * Fetch funksiyasi - https moduli bilan (CommonJS uchun)
 */
function fetch(url, options = {}) {
    return new Promise((resolve, reject) => {
        try {
            const urlObj = new URL(url);
            const bodyString = options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : null;
            
            const requestOptions = {
                hostname: urlObj.hostname,
                port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                path: urlObj.pathname + urlObj.search,
                method: options.method || 'GET',
                headers: {
                    'User-Agent': 'TelegramBot/1.0',
                    ...options.headers
                },
                timeout: 60000
            };

            // Content-Length header qo'shish (agar body bo'lsa)
            if (bodyString) {
                requestOptions.headers['Content-Length'] = Buffer.byteLength(bodyString, 'utf8');
            }

            const protocol = urlObj.protocol === 'https:' ? https : http;
            
            const req = protocol.request(requestOptions, (res) => {
                let data = '';
                
                res.on('data', (chunk) => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    const response = {
                        ok: res.statusCode >= 200 && res.statusCode < 300,
                        status: res.statusCode,
                        statusText: res.statusMessage,
                        headers: res.headers,
                        text: () => Promise.resolve(data),
                        json: () => {
                            try {
                                return Promise.resolve(JSON.parse(data));
                            } catch (e) {
                                return Promise.reject(new Error(`JSON parsing error: ${e.message}`));
                            }
                        },
                        data: data
                    };
                    resolve(response);
                });
            });
            
            req.on('error', (error) => {
                reject(error);
            });
            
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });
            
            if (bodyString) {
                req.write(bodyString, 'utf8');
            }
            
            req.end();
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * OpenRouter API ga so'rov yuborish
 */
async function callOpenRouterAPI(messages, lang = 'uz') {
    const systemMsg = getSystemMessage(lang);
    const chatPayload = {
        model: "openai/gpt-3.5-turbo",
        messages: [
            { role: "system", content: systemMsg },
            ...messages
        ]
    };

    const chatRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${OPENROUTER_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/your-repo", // OpenRouter talab qiladi
            "X-Title": "ChatMaster AI Bot"
        },
        body: JSON.stringify(chatPayload)
    });

    if (!chatRes.ok) {
        const errorText = await chatRes.text();
        console.error("❌ OpenRouter API xatosi:", {
            status: chatRes.status,
            statusText: chatRes.statusText,
            error: errorText,
            payload: chatPayload
        });
        throw new Error(`API Error: ${chatRes.status} - ${errorText}`);
    }

    const chatData = await chatRes.json();
    const reply = chatData?.choices?.[0]?.message?.content || 
                 chatData?.choices?.[0]?.text || 
                 null;

    if (!reply) {
        console.error("❌ Javob topilmadi:", chatData);
        throw new Error("Javob topilmadi");
    }

    return reply;
}

/**
 * System message ni tilga ko'ra qaytarish
 */
function getSystemMessage(lang) {
    const messages = {
        uz: "Siz aqlli yordamchisiz, foydalanuvchining savoliga javob bering.",
        ru: "Вы умный помощник. Отвечайте на вопросы пользователя подробно и полезно.",
        en: "You are a smart assistant. Answer the user's questions in detail and helpfully."
    };
    return messages[lang] || messages.uz;
}

/**
 * Xatolik xabarini tilga ko'ra qaytarish
 */
function getErrorMessage(type, lang) {
    const messages = {
        uz: {
            api: "❌ Javobni olishda xatolik",
            connection: "❌ Ulanish xatosi",
            notFound: "❌ Javob topilmadi",
            ocr: "❌ Rasmdan matn o'qib bo'lmadi",
            noText: "❌ Rasmdan matn topilmadi",
            voice: "❌ Men faqat matn bilan javob bera olaman"
        },
        ru: {
            api: "❌ Ошибка при получении ответа",
            connection: "❌ Ошибка соединения",
            notFound: "❌ Ответ не найден",
            ocr: "❌ Rasmdan matn o'qib bo'lmadi",
            noText: "❌ Rasmdan matn topilmadi",
            voice: "❌ Я могу отвечать только текстом"
        },
        en: {
            api: "❌ Error getting response",
            connection: "❌ Connection error",
            notFound: "❌ Answer not found",
            ocr: "❌ Could not read text from image",
            noText: "❌ No text found in image",
            voice: "❌ I can only reply in text"
        }
    };
    return messages[lang]?.[type] || messages.uz[type];
}

/**
 * Rasm yuklash funksiyasi
 */
function downloadImage(url, filePath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(filePath);
        
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                fs.unlink(filePath, () => {});
                file.close();
                reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
                return;
            }
            
            response.pipe(file);
            file.on("finish", () => {
                file.close(resolve);
            });
            file.on("error", (err) => {
                fs.unlink(filePath, () => {});
                reject(err);
            });
        }).on("error", (err) => {
            fs.unlink(filePath, () => {});
            reject(err);
        });
    });
}

/**
 * OCR bilan rasmdan matn olish
 */
async function extractTextFromImage(imagePath, lang = 'uz') {
    try {
        const result = await Tesseract.recognize(imagePath, 'eng+rus', {
            logger: m => {
                if (m.status === 'recognizing text') {
                    console.log(`OCR progress: ${Math.round(m.progress * 100)}%`);
                }
            }
        });
        return result.data.text.trim();
    } catch (error) {
        console.error("OCR xatosi:", error);
        throw error;
    }
}

// ==================== BOT SETUP ====================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const userLanguage = {};

// ==================== BOT HANDLERS ====================

// /start komandasi
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const opts = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "🇺🇿 Uzbek", callback_data: "lang_uz" }],
                [{ text: "🇷🇺 Русский", callback_data: "lang_ru" }],
                [{ text: "🇬🇧 English", callback_data: "lang_en" }]
            ]
        }
    };
    await bot.sendMessage(
        chatId,
        "👋 Salom! Men ChatMaster AI 🤖\n\nIltimos tilni tanlang / Please choose your language / Пожалуйста, выберите язык:",
        opts
    );
});

// Til tanlash
bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data.startsWith("lang_")) {
        const lang = data.split("_")[1];
        userLanguage[chatId] = lang;

        const welcomeMessages = {
            uz: "Men ChatMaster AI — sizning aqlli yordamchingizman. Savollarga javob beraman, rasmlarni tahlil qilaman va o'qishga yordam beraman!",
            ru: "Я ChatMaster AI — ваш умный помощник. Отвечаю на вопросы, анализирую изображения и помогаю с обучением!",
            en: "I am ChatMaster AI — your smart assistant. I answer questions, analyze images, and help with learning!"
        };

        await bot.sendMessage(chatId, welcomeMessages[lang] || welcomeMessages.uz);
        await bot.answerCallbackQuery(query.id);
    }
});

// Xabarlarni qabul qilish
bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const lang = userLanguage[chatId] || "uz";

    // /start komandasi e'tiborsiz qoldirish
    if (msg.text && msg.text.startsWith("/start")) {
        return;
    }

    // Voice xabarlar
    if (msg.voice) {
        await bot.sendMessage(chatId, getErrorMessage('voice', lang));
        return;
    }

    // Typing ko'rsatish
    await bot.sendChatAction(chatId, "typing");

    try {
        // Rasm bilan ishlash
        if (msg.photo) {
            await handlePhotoMessage(msg, chatId, lang);
            return;
        }

        // Oddiy matn xabarlar
        if (msg.text) {
            await handleTextMessage(msg, chatId, lang);
            return;
        }
    } catch (error) {
        console.error("❌ Umumiy xatolik:", error);
        await bot.sendMessage(chatId, getErrorMessage('connection', lang));
    }
});

/**
 * Rasm xabarlarini boshqarish
 */
async function handlePhotoMessage(msg, chatId, lang) {
    try {
        // Eng katta rasmni olish
        const photo = msg.photo[msg.photo.length - 1];
        const fileId = photo.file_id;
        
        // Fayl ma'lumotlarini olish
        const file = await bot.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
        const tempPath = path.join(__dirname, `temp_${fileId}.jpg`);
        
        // Rasmni yuklash
        await downloadImage(fileUrl, tempPath);
        
        // OCR bilan matn olish
        let text;
        try {
            text = await extractTextFromImage(tempPath, lang);
        } catch (ocrError) {
            console.error("OCR xatosi:", ocrError);
            await bot.sendMessage(chatId, getErrorMessage('ocr', lang));
            fs.unlinkSync(tempPath);
            return;
        } finally {
            // Temp faylni o'chirish
            if (fs.existsSync(tempPath)) {
                fs.unlinkSync(tempPath);
            }
        }
        
        // Matn topilmadi
        if (!text || text.length === 0) {
            await bot.sendMessage(chatId, getErrorMessage('noText', lang));
            return;
        }
        
        // AI ga so'rov yuborish
        const userMsg = lang === "ru"
            ? `Текст с изображения: ${text}\n\nОтветьте на вопросы по этому тексту или проанализируйте его.`
            : lang === "en"
            ? `Text from image: ${text}\n\nAnswer questions about this text or analyze it.`
            : `Rasmdan olingan matn: ${text}\n\nBu matn haqida javob bering yoki tahlil qiling.`;
        
        const reply = await callOpenRouterAPI([{ role: "user", content: userMsg }], lang);
        await bot.sendMessage(chatId, reply);
        
    } catch (error) {
        console.error("❌ Rasm xabari xatosi:", error);
        await bot.sendMessage(chatId, getErrorMessage('api', lang));
    }
}

/**
 * Matn xabarlarini boshqarish
 */
async function handleTextMessage(msg, chatId, lang) {
    try {
        const reply = await callOpenRouterAPI(
            [{ role: "user", content: msg.text }],
            lang
        );
        await bot.sendMessage(chatId, reply);
    } catch (error) {
        console.error("❌ Matn xabari xatosi:", error);
        await bot.sendMessage(chatId, getErrorMessage('api', lang));
    }
}

// ==================== STARTUP ====================
console.log("✅ ChatMaster AI bot ishga tushdi!");
console.log("✅ Bot is ready to receive messages...");
