require('dotenv').config();
const tmi = require('tmi.js');
const fs = require('fs');
const fetch = require('node-fetch');

const POLL_DURATION = 30 * 1000; // 30 seconds
let pollActive = false;
let pollQuestion = '';
let votes = { '0': 0, '1': 0 };
let voters = new Set(); // Track voters to prevent duplicate votes

// 📌 Twitch Bot Config
const client = new tmi.Client({
    options: { debug: true },
    connection: { reconnect: true, secure: true },
    identity: {
        username: process.env.TWITCH_BOT_USERNAME,
        password: process.env.TWITCH_OAUTH_TOKEN
    },
    channels: [process.env.TWITCH_CHANNEL]
});

// 📌 Unified API Fetch Function
async function fetchTwitchAPI(endpoint) {
    try {
        const url = `https://api.twitch.tv/helix/${endpoint}`;
        const response = await fetch(url, {
            headers: {
                "Authorization": `Bearer ${process.env.TWITCH_OAUTH_TOKEN}`,
                "Client-Id": process.env.TWITCH_CLIENT_ID
            }
        });

        if (!response.ok) throw new Error(`Twitch API error: ${response.status} ${response.statusText}`);

        return await response.json();
    } catch (error) {
        console.error(`Error fetching ${endpoint}:`, error.message);
        return null;
    }
}

// 📌 API Handlers
async function getViewers() {
    const data = await fetchTwitchAPI(`streams?user_id=${process.env.TWITCH_BROADCASTER_ID}`);
    return data?.data?.length ? `Current viewers: ${data.data[0].viewer_count}` : "No active viewers.";
}

async function getUptime() {
    const data = await fetchTwitchAPI(`streams?user_id=${process.env.TWITCH_BROADCASTER_ID}`);
    if (!data?.data?.length) return "The stream is currently offline.";

    const startTime = new Date(data.data[0].started_at);
    const uptimeMs = new Date() - startTime;
    return `Stream has been live for ${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m.`;
}

async function getFollowers() {
    const data = await fetchTwitchAPI(`users/follows?to_id=${process.env.TWITCH_BROADCASTER_ID}`);
    return data?.total ? `Current follower count: ${data.total}` : "Error retrieving follower count.";
}

// 📌 Poll System
async function startPoll(channel, question) {
    if (pollActive) {
        client.say(channel, "⚠️ A poll is already active! Please wait for it to finish.");
        return;
    }

    pollActive = true;
    pollQuestion = question;
    votes = { '0': 0, '1': 0 };
    voters.clear(); // Reset voters

    client.say(channel, `📊 Poll started: "${pollQuestion}" Type '0' for NO or '1' for YES. You have 30 seconds!`);

    setTimeout(() => {
        pollActive = false;
        const totalVotes = votes['0'] + votes['1'];
        const winner = votes['1'] > votes['0'] ? 'YES (1)' : votes['0'] > votes['1'] ? 'NO (0)' : "It's a tie!";

        client.say(channel, `📢 Poll ended: "${pollQuestion}" YA'LL VOTED: ${winner.toUpperCase()}`);

        // Log poll results
        const logEntry = {
            timestamp: new Date().toISOString(),
            question: pollQuestion,
            results: votes,
            winner: winner,
            totalVotes: totalVotes
        };
        fs.appendFile("poll_results.json", JSON.stringify(logEntry) + "\n", (err) => {
            if (err) console.error("Error writing poll result:", err);
        });

    }, POLL_DURATION);
}

// 📌 Log Chat Messages
function logChatMessage(channel, user, message) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        user: user.username,
        message: message
    };
    fs.appendFile('chatlog.json', JSON.stringify(logEntry) + "\n", (err) => {
        if (err) console.error("Error logging message:", err);
    });
}

// 📌 Commands with Descriptions
const commands = {
    "!viewers": { execute: async (channel) => client.say(channel, await getViewers()), description: "Show current viewers" },
    "!uptime": { execute: async (channel) => client.say(channel, await getUptime()), description: "Show stream uptime" },
    "!followers": { execute: async (channel) => client.say(channel, await getFollowers()), description: "Show follower count" },
    "!hello": { execute: (channel, tags) => client.say(channel, `Hello, ${tags.username}!`), description: "Greet the bot" },
    "!wrud": { execute: (channel, tags) => client.say(channel, `${tags['display-name']} is learning Linux/NeoVim & Docker.`), description: "See what the bot is doing" },
    "!shoutout": { 
        execute: (channel, _, args) => {
            if (!args.length) {
                client.say(channel, "⚠️ Usage: !shoutout [username]");
                return;
            }
            client.say(channel, `Shoutout to ${args[0].replace("@", "")}! Go check them out!`);
        }, 
        description: "Give a shoutout → !shoutout [user]" 
    },
    "!dice": { execute: (channel, tags) => client.say(channel, `${tags.username} rolled a ${Math.floor(Math.random() * 6) + 1}! 🎲`), description: "Roll a dice" },
    "!startpoll": { 
        execute: (channel, _, args) => {
            if (!args.length) {
                client.say(channel, "⚠️ Usage: !startpoll [question]");
                return;
            }
            startPoll(channel, args.join(" ").replace(/['"]/g, "")); // Remove quotes
        }, 
        description: "Start a poll → !startpoll [question]" 
    },
    "!commands": { 
        execute: (channel) => {
            const commandList = Object.entries(commands)
                .map(([cmd, details]) => `${cmd} - ${details.description}`)
                .join('\n'); // ⬅ Newline formatting

            // Send the command list **line by line** since Twitch chat limits message length
            client.say(channel, `Commands available:\n${commandList}`);
        },
        description: "Show all available commands"
    }
};

// 📌 Message Handler
client.on('message', async (channel, tags, message, self) => {
    if (self) return;
    logChatMessage(channel, tags, message);

    const [cmd, ...args] = message.toLowerCase().split(" ");

    if (pollActive && (cmd === "0" || cmd === "1")) {
        if (!voters.has(tags.username)) {
            votes[cmd]++;
            voters.add(tags.username);
            console.log(`Vote received: ${tags.username} voted ${cmd}`);
        } else {
            client.say(channel, `${tags.username}, you've already voted!`);
        }
    } else if (commands[cmd]) {
        if (cmd === "!commands") {
            // Only show descriptions for !commands
            commands[cmd].execute(channel);
        } else {
            // Execute command without showing description
            commands[cmd].execute(channel, tags, args);
        }
    }
});

// 📌 Periodic Chat Reminders
const reminders = [
    "💡 Don't forget to follow the stream! 🚀",
    "🎮 Stay hydrated & stretch! Gaming & coding require good posture! 💪",
    "🔥 Type !commands to see available commands!",
    "💬 Join the chat & say hello! Let's hang out! 😃"
];

setInterval(() => {
    const message = reminders[Math.floor(Math.random() * reminders.length)];
    client.say(process.env.TWITCH_CHANNEL, message);
    console.log(`Reminder sent: ${message}`);
}, 600000); // 10 minutes

// Connect Bot
client.connect();

