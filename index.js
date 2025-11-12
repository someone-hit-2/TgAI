const TelegramBot = require("node-telegram-bot-api");
require("dotenv").config();
const Tesseract = require("tesseract.js");  
const fs = require("fs");
const https = require("https");
const path = require("path");

// Fetch funksiyasini https moduli bilan yaratish (CommonJS uchun)
function fetch(url, options = {}) {
    return new Promise((resolve, reject) => {
        try {
            const urlObj = new URL(url);
            const requestOptions = {
                hostname: urlObj.hostname,
                port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                path: urlObj.pathname + urlObj.search,
                method: options.method || 'GET',
                headers: {
                    ...options.headers
                }
            };

            const protocol = urlObj.protocol === 'https:' ? https : require('http');
            
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
                                return Promise.reject(new Error(`JSON parsing error: ${e.message}. Data: ${data.substring(0, 200)}`));
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
            
            // Timeout qo'shish (60 soniya)
            req.setTimeout(60000);
            
            if (options.body) {
                const bodyString = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
                req.write(bodyString, 'utf8');
            }
            
            req.end();
        } catch (error) {
            reject(error);
        }
    });
}

const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENROUTER_KEY = process.env.OPENROUTER_KEY;

if (!BOT_TOKEN || !OPENROUTER_KEY) {
    console.error("Iltimos .env faylida TELEGRAM_TOKEN va OPENROUTER_KEY borligini tekshiring.");
    process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const userLanguage = {}; 

// Til tanlash va /start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const opts = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "🇺🇿 Uzbek", callback_data: "lang_uz" }],
                [{ text: "🇷🇺 Русский", callback_data: "lang_ru" }],
                [{ text: "🇬🇧 English", callback_data: "lang_en" }],
            ],
        },
    };
    await bot.sendMessage(chatId, "👋 Salom! Men ChatMaster AI 🤖\n\nIltimos tilni tanlang / Please choose your language / Пожалуйста, выберите язык:", opts);
});

bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data.startsWith("lang_")) {
        const lang = data.split("_")[1];
        userLanguage[chatId] = lang;

        let welcomeText;
        if (lang === "uz") {
            welcomeText = "Men ChatMaster AI — sizning aqlli yordamchingizman. Savollarga javob beraman, rasmlarni tahlil qilaman va o‘qishga yordam beraman!";
        } else if (lang === "ru") {
            welcomeText = "Я ChatMaster AI — ваш умный помощник. Отвечаю на вопросы, анализирую изображения и помогаю с обучением!";
        } else {
            welcomeText = "I am ChatMaster AI — your smart assistant. I answer questions, analyze images, and help with learning!";
        }

        await bot.sendMessage(chatId, welcomeText);
        await bot.answerCallbackQuery(query.id);
    }
});

// Rasm yuklash funksiyasi
async function downloadImage(url, path) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(path);
        https.get(url, (response) => {
            // HTTP xatolarni tekshirish
            if (response.statusCode !== 200) {
                fs.unlink(path, () => {});
                file.close();
                reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
                return;
            }
            
            response.pipe(file);
            file.on("finish", () => {
                file.close(resolve);
            });
            file.on("error", (err) => {
                fs.unlink(path, () => {});
                reject(err);
            });
        }).on("error", (err) => {
            fs.unlink(path, () => {});
            reject(err);
        });
    });
}

// Asosiy xabar qabul qilish
bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const lang = userLanguage[chatId] || "uz";

    // Agar foydalanuvchi /start yuborsa, hech narsa qilmaymiz
    if (msg.text && msg.text.startsWith("/start")) return;

    // Voice xabarlar
    if (msg.voice) {
        await bot.sendMessage(chatId, lang === "ru" ? "❌ Я могу отвечать только текстом" : lang === "en" ? "❌ I can only reply in text" : "❌ Men faqat matn bilan javob bera olaman");
        return;
    }

    await bot.sendChatAction(chatId, "typing");

    try {
        // Rasm bo'lsa
        if (msg.photo) {
            const photo = msg.photo[msg.photo.length - 1]; // Eng katta rasm
            const fileId = photo.file_id;
            
            const file = await bot.getFile(fileId);
            const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
            const tempPath = path.join(__dirname, `temp_${fileId}.jpg`);
            
            await downloadImage(fileUrl, tempPath);
            
            // OCR bilan matn olish
            let text;
            try {
                // Tesseract til kodlari: eng (English), rus (Russian)
                // uzb (Uzbek) mavjud emas bo'lishi mumkin, shuning uchun eng+rus ishlatamiz
                const result = await Tesseract.recognize(tempPath, 'eng+rus', {
                    logger: m => console.log(m)
                });
                text = result.data.text;
            } catch (ocrError) {
                console.error("OCR xatosi:", ocrError);
                const errorMsg = lang === "ru" 
                    ? "❌ Rasmdan matn o'qib bo'lmadi" 
                    : lang === "en" 
                    ? "❌ Could not read text from image" 
                    : "❌ Rasmdan matn o'qib bo'lmadi";
                await bot.sendMessage(chatId, errorMsg);
                fs.unlinkSync(tempPath);
                return;
            }
            
            // Temp faylni o'chirish
            fs.unlinkSync(tempPath);
            
            if (!text || text.trim().length === 0) {
                const noTextMsg = lang === "ru" 
                    ? "❌ Rasmdan matn topilmadi" 
                    : lang === "en" 
                    ? "❌ No text found in image" 
                    : "❌ Rasmdan matn topilmadi";
                await bot.sendMessage(chatId, noTextMsg);
                return;
            }
            
            // OCR natijasini AI ga yuborish
            const systemMsg = lang === "ru"
                ? "Вы умный помощник. Проанализируйте текст с изображения и ответьте на вопросы пользователя."
                : lang === "en"
                ? "You are a smart assistant. Analyze the text from the image and answer the user's questions."
                : "Siz aqlli yordamchisiz. Rasmdan olingan matnni tahlil qiling va foydalanuvchining savoliga javob bering.";
            
            const userMsg = lang === "ru"
                ? `Текст с изображения: ${text}\n\nОтветьте на вопросы по этому тексту или проанализируйте его.`
                : lang === "en"
                ? `Text from image: ${text}\n\nAnswer questions about this text or analyze it.`
                : `Rasmdan olingan matn: ${text}\n\nBu matn haqida javob bering yoki tahlil qiling.`;
            
            const chatPayload = {
                model: "gpt-3.5-turbo",
                messages: [
                    { role: "system", content: systemMsg },
                    { role: "user", content: userMsg }
                ]
            };
            
            try {
                const chatRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${OPENROUTER_KEY}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify(chatPayload)
                });
                
                if (!chatRes.ok) {
                    const errorText = await chatRes.text();
                    console.error("OpenRouter xatosi (rasm):", chatRes.status, errorText);
                    console.error("Request payload:", JSON.stringify(chatPayload, null, 2));
                    const errorMsg = lang === "ru" 
                        ? "❌ Ошибка при получении ответа" 
                        : lang === "en" 
                        ? "❌ Error getting response" 
                        : "❌ Javobni olishda xatolik";
                    await bot.sendMessage(chatId, errorMsg);
                    return;
                }
                
                let chatData;
                try {
                    chatData = await chatRes.json();
                } catch (jsonError) {
                    console.error("JSON parsing xatosi (rasm):", jsonError);
                    console.error("Response data:", chatRes.data);
                    await bot.sendMessage(chatId, lang === "ru" ? "❌ Ответ не найден" : lang === "en" ? "❌ Answer not found" : "❌ Javob topilmadi");
                    return;
                }
                
                const reply = chatData?.choices?.[0]?.message?.content || 
                             (lang === "ru" ? "❌ Ответ не найден" : lang === "en" ? "❌ Answer not found" : "❌ Javob topilmadi");
                
                await bot.sendMessage(chatId, reply);
                return;
            } catch (fetchError) {
                console.error("Fetch xatosi (rasm):", fetchError);
                console.error("Error stack:", fetchError.stack);
                await bot.sendMessage(chatId, lang === "ru" ? "❌ Ошибка соединения" : lang === "en" ? "❌ Connection error" : "❌ Ulanish xatosi");
                return;
            }
        }

        // Oddiy matn
        if (!msg.text) return;

        const systemMsg = lang === "ru"
            ? "Вы умный помощник. Отвечайте на вопросы пользователя подробно и полезно."
            : lang === "en"
            ? "You are a smart assistant. Answer the user's questions in detail and helpfully."
            : "Siz aqlli yordamchisiz, foydalanuvchining savoliga javob bering.";
        
        const chatPayload = {
            model: "gpt-3.5-turbo",
            messages: [
                { role: "system", content: systemMsg },
                { role: "user", content: msg.text }
            ]
        };

        try {
            const chatRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${OPENROUTER_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(chatPayload)
            });

            if (!chatRes.ok) {
                const errorText = await chatRes.text();
                console.error("OpenRouter xatosi:", chatRes.status, errorText);
                console.error("Request payload:", JSON.stringify(chatPayload, null, 2));
                return await bot.sendMessage(chatId, lang === "ru" ? "❌ Ошибка при получении ответа" : lang === "en" ? "❌ Error getting response" : "❌ Javobni olishda xatolik");
            }

            let chatData;
            try {
                chatData = await chatRes.json();
                console.log("API javobi:", JSON.stringify(chatData, null, 2));
            } catch (jsonError) {
                console.error("JSON parsing xatosi:", jsonError);
                console.error("Response data:", chatRes.data);
                return await bot.sendMessage(chatId, lang === "ru" ? "❌ Ответ не найден" : lang === "en" ? "❌ Answer not found" : "❌ Javob topilmadi");
            }

            const reply =
                chatData?.choices?.[0]?.message?.content ||
                chatData?.choices?.[0]?.text ||
                (lang === "ru" ? "❌ Ответ не найден" : lang === "en" ? "❌ Answer not found" : "❌ Javob topilmadi");

            await bot.sendMessage(chatId, reply);
        } catch (fetchError) {
            console.error("Fetch xatosi:", fetchError);
            console.error("Error stack:", fetchError.stack);
            await bot.sendMessage(chatId, lang === "ru" ? "❌ Ошибка соединения" : lang === "en" ? "❌ Connection error" : "❌ Ulanish xatosi");
        }

    } catch (err) {
        console.error(err);
        await bot.sendMessage(chatId, lang === "ru" ? "❌ Ошибка" : lang === "en" ? "❌ Error" : "❌ Xatolik yuz berdi");
    }
});
