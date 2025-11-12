const TelegramBot = require("node-telegram-bot-api");
require("dotenv").config();
const fetch = global.fetch || require("node-fetch");
const Tesseract = require("tesseract.js");  
const fs = require("fs");
const https = require("https");

const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENROUTER_KEY = process.env.OPENROUTER_KEY;

if (!BOT_TOKEN || !OPENROUTER_KEY) {
    console.error("Iltimos .env faylida TELEGRAM_TOKEN va OPENROUTER_KEY borligini tekshiring.");
    process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const userLanguage = {}; 

// Til tanlash
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

// Rasm yuklash
async function downloadImage(url, path) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(path);
        https.get(url, (response) => {
            response.pipe(file);
            file.on("finish", () => file.close(resolve));
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

    if (msg.voice) {
        await bot.sendMessage(chatId, lang === "ru" ? "❌ Я могу отвечать только текстом" : lang === "en" ? "❌ I can only reply in text" : "❌ Men faqat matn bilan javob bera olaman");
        return;
    }

    bot.sendChatAction(chatId, "typing");

    try {
        // Agar rasm bo'lsa
        if (msg.photo) {
            const fileId = msg.photo[msg.photo.length - 1].file_id;
            const fileLink = await bot.getFileLink(fileId);
            const localFile = `./temp_${chatId}.jpg`;
            await downloadImage(fileLink, localFile);

            bot.sendChatAction(chatId, "typing");

            // OCR bilan matn olish
            const { data: { text } } = await Tesseract.recognize(localFile, 'eng', {
                logger: m => console.log("OCR:", m)
            });

            console.log("OCR matni:", text);

            fs.unlinkSync(localFile); // faylni o'chirish

            if (!text.trim()) {
                return await bot.sendMessage(chatId, lang === "ru" ? "❌ Текст не найден на изображении" : lang === "en" ? "❌ No text found in the image" : "❌ Rasmdan matn topilmadi");
            }

            // OpenRouter API ga so'rov
            const payload = {
                model: "gpt-3.5-turbo",
                messages: [
                    { role: "system", content: "Siz test varaqasini tahlil qiluvchi AI yordamchisiz. Matndagi savollar va javoblarni toping." },
                    { role: "user", content: text }
                ]
            };

            const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${OPENROUTER_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                console.error("OpenRouter xatosi:", res.status, await res.text());
                return await bot.sendMessage(chatId, lang === "ru" ? "❌ Ошибка при получении ответа" : lang === "en" ? "❌ Error getting response" : "❌ Javobni olishda xatolik");
            }

            const data = await res.json();
            console.log("Chat javobi:", data);

            const reply = data?.choices?.[0]?.message?.content || (lang === "ru" ? "❌ Ответ не найден" : lang === "en" ? "❌ Answer not found" : "❌ Javob topilmadi");
            await bot.sendMessage(chatId, reply);
            return;
        }

        // Agar oddiy matn bo'lsa
        if (!msg.text) return;

        const chatPayload = {
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: msg.text }]
        };

        const chatRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${OPENROUTER_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(chatPayload)
        });

        if (!chatRes.ok) {
            console.error("OpenRouter xatosi:", chatRes.status, await chatRes.text());
            return await bot.sendMessage(chatId, lang === "ru" ? "❌ Ошибка при получении ответа" : lang === "en" ? "❌ Error getting response" : "❌ Javobni olishda xatolik");
        }

        const chatData = await chatRes.json();
        console.log("Chat javobi:", chatData);

        const reply = chatData?.choices?.[0]?.message?.content || (lang === "ru" ? "❌ Ответ не найден" : lang === "en" ? "❌ Answer not found" : "❌ Javob topilmadi");
        await bot.sendMessage(chatId, reply);

    } catch (err) {
        console.error(err);
        await bot.sendMessage(chatId, lang === "ru" ? "❌ Ошибка" : lang === "en" ? "❌ Error" : "❌ Xatolik yuz berdi");
    }
});
