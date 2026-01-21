require('dotenv').config();

const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Bot configuration
const TOKEN = process.env.DISCORD_BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '927071447300571137';
const DATABASE_URL = process.env.DATABASE_URL;

// PostgreSQL connection pool (only if DATABASE_URL exists)
let pool = null;
let useDatabase = false;

if (DATABASE_URL) {
    pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
    });
    useDatabase = true;
    console.log('✅ Using PostgreSQL database for storage');
} else {
    console.log('⚠️ No DATABASE_URL found, using JSON file storage');
}

// File path for persistent storage (fallback)
const DATA_FILE = path.join(__dirname, 'playerData.json');

// In-memory storage for player resources
let playerData = new Map();

// Active encounter data
let activeEncounter = {
    active: false,
    combatants: [] // Array of userIds
};

// Attack and Cast counters (resets on /turn)
let attackCounters = new Map(); // userId -> count
let castCounters = new Map(); // userId -> count

// Cumulative penalty tracking
let attackPenalties = new Map(); // userId -> { gate: 0, damageReduction: 0, blind: false }
let castPenalties = new Map(); // userId -> { gate: 0, damageReduction: 0, blind: false }

// Resource types
const RESOURCES = ['HP', 'MP', 'IP', 'Armor', 'Barrier'];

// Resource emojis
const RESOURCE_EMOJIS = {
    HP: '❤️',
    MP: '💧',
    IP: '💰',
    Armor: '💥',
    Barrier: '🛡️'
};

// Initialize database tables
async function initDatabase() {
    if (!useDatabase) return;

    try {
        // Create players table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS players (
                user_id TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                character_name TEXT NOT NULL,
                hp INTEGER DEFAULT 0,
                mp INTEGER DEFAULT 0,
                ip INTEGER DEFAULT 0,
                armor INTEGER DEFAULT 0,
                barrier INTEGER DEFAULT 0,
                max_hp INTEGER DEFAULT 0,
                max_mp INTEGER DEFAULT 0,
                max_ip INTEGER DEFAULT 0,
                max_armor INTEGER DEFAULT 0,
                max_barrier INTEGER DEFAULT 0,
                status_effects JSONB DEFAULT '[]'::jsonb,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create encounters table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS encounters (
                id SERIAL PRIMARY KEY,
                active BOOLEAN DEFAULT false,
                combatants JSONB DEFAULT '[]'::jsonb,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Ensure there's at least one encounter row
        await pool.query(`
            INSERT INTO encounters (id, active, combatants)
            VALUES (1, false, '[]'::jsonb)
            ON CONFLICT DO NOTHING
        `);

        console.log('✅ Database tables initialized');
    } catch (error) {
        console.error('❌ Error initializing database:', error);
    }
}

// Load data from database or file
async function loadData() {
    if (useDatabase) {
        try {
            // Load players
            const playersResult = await pool.query('SELECT * FROM players');
            playerData.clear();
            
            for (const row of playersResult.rows) {
                playerData.set(row.user_id, {
                    username: row.username,
                    characterName: row.character_name,
                    HP: row.hp,
                    MP: row.mp,
                    IP: row.ip,
                    Armor: row.armor,
                    Barrier: row.barrier,
                    maxHP: row.max_hp,
                    maxMP: row.max_mp,
                    maxIP: row.max_ip,
                    maxArmor: row.max_armor,
                    maxBarrier: row.max_barrier,
                    statusEffects: row.status_effects || []
                });
            }

            // Load encounter
            const encounterResult = await pool.query('SELECT * FROM encounters WHERE id = 1');
            if (encounterResult.rows.length > 0) {
                activeEncounter = {
                    active: encounterResult.rows[0].active,
                    combatants: encounterResult.rows[0].combatants || []
                };
            }

            console.log(`✅ Loaded ${playerData.size} players from database`);
        } catch (error) {
            console.error('❌ Error loading from database:', error);
        }
    } else {
        // Fallback to JSON file
        try {
            if (fs.existsSync(DATA_FILE)) {
                const rawData = fs.readFileSync(DATA_FILE, 'utf8');
                const parsed = JSON.parse(rawData);
                playerData = new Map(Object.entries(parsed.players || parsed));
                activeEncounter = parsed.encounter || { active: false, combatants: [] };
                console.log(`Loaded data for ${playerData.size} players from ${DATA_FILE}`);
            } else {
                console.log('No existing data file found. Starting fresh.');
            }
        } catch (error) {
            console.error('Error loading data:', error);
            console.log('Starting with empty data.');
        }
    }
}

// Save data to database or file
async function saveData() {
    if (useDatabase) {
        try {
            // Save all players
            for (const [userId, data] of playerData) {
                await pool.query(`
                    INSERT INTO players (
                        user_id, username, character_name,
                        hp, mp, ip, armor, barrier,
                        max_hp, max_mp, max_ip, max_armor, max_barrier,
                        status_effects, updated_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, CURRENT_TIMESTAMP)
                    ON CONFLICT (user_id) 
                    DO UPDATE SET
                        username = $2,
                        character_name = $3,
                        hp = $4,
                        mp = $5,
                        ip = $6,
                        armor = $7,
                        barrier = $8,
                        max_hp = $9,
                        max_mp = $10,
                        max_ip = $11,
                        max_armor = $12,
                        max_barrier = $13,
                        status_effects = $14,
                        updated_at = CURRENT_TIMESTAMP
                `, [
                    userId,
                    data.username,
                    data.characterName,
                    data.HP,
                    data.MP,
                    data.IP,
                    data.Armor,
                    data.Barrier,
                    data.maxHP,
                    data.maxMP,
                    data.maxIP,
                    data.maxArmor,
                    data.maxBarrier,
                    JSON.stringify(data.statusEffects || [])
                ]);
            }

            // Save encounter
            await pool.query(`
                UPDATE encounters 
                SET active = $1, combatants = $2, updated_at = CURRENT_TIMESTAMP
                WHERE id = 1
            `, [activeEncounter.active, JSON.stringify(activeEncounter.combatants)]);

            console.log(`✅ Saved ${playerData.size} players to database`);
        } catch (error) {
            console.error('❌ Error saving to database:', error);
        }
    } else {
        // Fallback to JSON file
        try {
            const dataObject = {
                players: Object.fromEntries(playerData),
                encounter: activeEncounter
            };
            fs.writeFileSync(DATA_FILE, JSON.stringify(dataObject, null, 2), 'utf8');
            console.log(`Data saved for ${playerData.size} players`);
        } catch (error) {
            console.error('Error saving data:', error);
        }
    }
}

// Delete player from database
async function deletePlayer(userId) {
    if (useDatabase) {
        try {
            await pool.query('DELETE FROM players WHERE user_id = $1', [userId]);
            console.log(`✅ Deleted player ${userId} from database`);
        } catch (error) {
            console.error('❌ Error deleting player from database:', error);
        }
    }
    // Also delete from memory
    playerData.delete(userId);
}

// Initialize player data
function initPlayer(userId, displayName, characterName = null) {
    if (!playerData.has(userId)) {
        playerData.set(userId, {
            username: displayName,
            characterName: characterName || displayName,
            HP: 0,
            MP: 0,
            IP: 0,
            Armor: 0,
            Barrier: 0,
            maxHP: 0,
            maxMP: 0,
            maxIP: 0,
            maxArmor: 0,
            maxBarrier: 0,
            statusEffects: []  // Array of {name: string, duration: number}
        });
    } else {
        // Update display name in case it changed
        playerData.get(userId).username = displayName;
        // Update character name if provided
        if (characterName) {
            playerData.get(userId).characterName = characterName;
        }
    }
}

// Create the bot client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
    ]
});

// Define slash commands
const commands = [
    new SlashCommandBuilder()
        .setName('set')
        .setDescription('Set a player\'s MAX resource values')
        .addUserOption(option =>
            option.setName('player')
                .setDescription('The player to set resources for')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('name')
                .setDescription('Character name (for display)')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('hp')
                .setDescription('Max HP value')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('mp')
                .setDescription('Max MP value')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('ip')
                .setDescription('Max IP value')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('armor')
                .setDescription('Max Armor value')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('barrier')
                .setDescription('Max Barrier value')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('view')
        .setDescription('View a player\'s current resources')
        .addUserOption(option =>
            option.setName('player')
                .setDescription('The player to view (leave empty for yourself)')
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName('update')
        .setDescription('Add or subtract from a resource')
        .addStringOption(option =>
            option.setName('resource')
                .setDescription('The resource to update')
                .setRequired(true)
                .addChoices(
                    { name: 'HP', value: 'HP' },
                    { name: 'MP', value: 'MP' },
                    { name: 'IP', value: 'IP' },
                    { name: 'Armor', value: 'Armor' },
                    { name: 'Barrier', value: 'Barrier' }
                ))
        .addIntegerOption(option =>
            option.setName('amount')
                .setDescription('Amount to add (positive) or subtract (negative)')
                .setRequired(true))
        .addUserOption(option =>
            option.setName('player')
                .setDescription('The player to update (leave empty for yourself)')
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName('status')
        .setDescription('Manage status effects (buffs/debuffs)')
        .addSubcommand(subcommand =>
            subcommand
                .setName('add')
                .setDescription('Add a status effect')
                .addStringOption(option =>
                    option.setName('name')
                        .setDescription('Name of the status effect (e.g., Bleed, Haste)')
                        .setRequired(true))
                .addIntegerOption(option =>
                    option.setName('duration')
                        .setDescription('Duration in turns')
                        .setRequired(true))
                .addUserOption(option =>
                    option.setName('player')
                        .setDescription('Player to apply status to (leave empty for yourself)')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('clear')
                .setDescription('Remove a status effect')
                .addStringOption(option =>
                    option.setName('name')
                        .setDescription('Name of the status effect to remove')
                        .setRequired(true))
                .addUserOption(option =>
                    option.setName('player')
                        .setDescription('Player to remove status from (leave empty for yourself)')
                        .setRequired(false))),

    new SlashCommandBuilder()
        .setName('tick')
        .setDescription('Advance turn by 1 (reduces status durations by 1)')
        .addUserOption(option =>
            option.setName('player')
                .setDescription('Player to advance turn for (leave empty for yourself)')
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName('hp')
        .setDescription('Update your HP quickly')
        .addStringOption(option =>
            option.setName('amount')
                .setDescription('Amount to change (use "full" to max, "zero" to set 0)')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('mp')
        .setDescription('Update your MP quickly')
        .addStringOption(option =>
            option.setName('amount')
                .setDescription('Amount to change (use "full" to max, "zero" to set 0)')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('ip')
        .setDescription('Update your IP quickly')
        .addStringOption(option =>
            option.setName('amount')
                .setDescription('Amount to change (use "full" to max, "zero" to set 0)')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('armor')
        .setDescription('Update your Armor quickly')
        .addStringOption(option =>
            option.setName('amount')
                .setDescription('Amount to change (use "full" to max, "zero" to set 0)')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('barrier')
        .setDescription('Update your Barrier quickly')
        .addStringOption(option =>
            option.setName('amount')
                .setDescription('Amount to change (use "full" to max, "zero" to set 0)')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('rest')
        .setDescription('Restore all your resources to maximum'),

    new SlashCommandBuilder()
        .setName('reset')
        .setDescription('Reset all player data (GM only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    new SlashCommandBuilder()
        .setName('listall')
        .setDescription('List all players and their resources'),

    new SlashCommandBuilder()
        .setName('viewall')
        .setDescription('View all players and their resources in detail'),

    new SlashCommandBuilder()
        .setName('delete')
        .setDescription('Delete a player\'s data')
        .addUserOption(option =>
            option.setName('player')
                .setDescription('The player whose data to delete')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('damage')
        .setDescription('Apply damage (reduces Armor/Barrier first, then HP)')
        .addIntegerOption(option =>
            option.setName('amount')
                .setDescription('Amount of damage')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('type')
                .setDescription('Type of protection to use first')
                .setRequired(true)
                .addChoices(
                    { name: 'armor', value: 'armor' },
                    { name: 'barrier', value: 'barrier' }
                ))
        .addStringOption(option =>
            option.setName('players')
                .setDescription('Players to damage (mention multiple: @player1 @player2, or leave empty for self)')
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName('attack')
        .setDescription('Roll attack dice with damage calculation')
        .addIntegerOption(option =>
            option.setName('dice1')
                .setDescription('First dice size (e.g., 10 for d10)')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('dice2')
                .setDescription('Second dice size (e.g., 8 for d8)')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('modifier')
                .setDescription('Damage modifier (added to HighRoll)')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('penalties')
                .setDescription('Optional: Apply penalties manually (e.g., "gate" or "damage")')
                .setRequired(false)
                .addChoices(
                    { name: 'Gate +1', value: 'gate' },
                    { name: '-50% Modifier', value: 'damage50' },
                    { name: 'No Modifier', value: 'damage100' },
                    { name: 'Blind (Gate 3)', value: 'blind' }
                )),

    new SlashCommandBuilder()
        .setName('cast')
        .setDescription('Roll cast dice with damage calculation (MP penalty on 2nd+ cast)')
        .addIntegerOption(option =>
            option.setName('dice1')
                .setDescription('First dice size (e.g., 10 for d10)')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('dice2')
                .setDescription('Second dice size (e.g., 8 for d8)')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('modifier')
                .setDescription('Damage modifier (added to HighRoll)')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('penalties')
                .setDescription('Optional: Apply penalties manually')
                .setRequired(false)
                .addChoices(
                    { name: 'Gate +1', value: 'gate' },
                    { name: '-50% Modifier', value: 'damage50' },
                    { name: 'No Modifier', value: 'damage100' },
                    { name: 'Blind (Gate 3)', value: 'blind' }
                )),

    new SlashCommandBuilder()
        .setName('check')
        .setDescription('Roll a skill check (fails if ANY dice ≤ gate)')
        .addIntegerOption(option =>
            option.setName('dice1')
                .setDescription('First dice size (e.g., 10 for d10)')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('dice2')
                .setDescription('Second dice size (e.g., 8 for d8)')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('gate')
                .setDescription('Gate threshold (fail if ANY dice ≤ gate)')
                .setRequired(true))
        .addUserOption(option =>
            option.setName('player')
                .setDescription('Who is making this check? (leave empty for yourself)')
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName('turn')
        .setDescription('Start new round - refills Armor/Barrier for all combatants in clash (GM only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    new SlashCommandBuilder()
        .setName('resetpenalty')
        .setDescription('Reset attack or cast penalty for a player (GM only)')
        .addStringOption(option =>
            option.setName('type')
                .setDescription('Which penalty to reset')
                .setRequired(true)
                .addChoices(
                    { name: 'Attack', value: 'attack' },
                    { name: 'Cast', value: 'cast' }
                ))
        .addUserOption(option =>
            option.setName('player')
                .setDescription('Player to reset penalties for')
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    new SlashCommandBuilder()
        .setName('clash')
        .setDescription('Manage combat encounters')
        .addSubcommand(subcommand =>
            subcommand
                .setName('start')
                .setDescription('Start a new encounter (GM only)'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('end')
                .setDescription('End the current encounter (GM only)'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('add')
                .setDescription('Add players to the encounter')
                .addStringOption(option =>
                    option.setName('players')
                        .setDescription('Players to add (mention: @player1 @player2, or leave empty for yourself)')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('remove')
                .setDescription('Remove players from the encounter')
                .addStringOption(option =>
                    option.setName('players')
                        .setDescription('Players to remove (mention: @player1 @player2)')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('List all combatants in the active encounter')),

    new SlashCommandBuilder()
        .setName('guide')
        .setDescription('Show all available bot commands and how to use them')
].map(command => command.toJSON());

// Register commands
const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
    try {
        console.log('Started refreshing application (/) commands.');
        await rest.put(
            Routes.applicationCommands(CLIENT_ID),
            { body: commands },
        );
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
})();

// Bot ready event
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    console.log('Resource Tracker Bot is online!');
    
    // Initialize database if using PostgreSQL
    if (useDatabase) {
        await initDatabase();
    }
    
    // Load existing data
    await loadData();
});

// Handle slash commands
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    try {
        if (commandName === 'set') {
            const player = interaction.options.getUser('player');
            const playerMember = await interaction.guild.members.fetch(player.id);
            const characterName = interaction.options.getString('name');
            const newMaxHP = interaction.options.getInteger('hp');
            const newMaxMP = interaction.options.getInteger('mp');
            const newMaxIP = interaction.options.getInteger('ip');
            const newMaxArmor = interaction.options.getInteger('armor');
            const newMaxBarrier = interaction.options.getInteger('barrier');

            initPlayer(player.id, playerMember.displayName, characterName);
            const data = playerData.get(player.id);
            
            // Get current IP to preserve it
            const currentIP = data.IP || 0;

            // Update max values
            data.maxHP = newMaxHP;
            data.maxMP = newMaxMP;
            data.maxIP = newMaxIP;
            data.maxArmor = newMaxArmor;
            data.maxBarrier = newMaxBarrier;

            // Set HP, MP, Armor, and Barrier to new max, keep IP
            data.HP = newMaxHP;
            data.MP = newMaxMP;
            data.IP = currentIP; // Preserve current IP
            data.Armor = newMaxArmor; // Set to full
            data.Barrier = newMaxBarrier; // Set to full

            data.username = playerMember.displayName;
            data.characterName = characterName;

            saveData(); // Save after modification

            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle(`✨ Max Resources Set for ${characterName}`)
                .setDescription('HP, MP, Armor, and Barrier restored to max. IP preserved.')
                .addFields(
                    { name: `${RESOURCE_EMOJIS.HP} HP`, value: `${data.HP}/${data.maxHP}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.MP} MP`, value: `${data.MP}/${data.maxMP}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.IP} IP`, value: `${data.IP}/${data.maxIP}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.Armor} Armor`, value: `${data.Armor}/${data.maxArmor}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.Barrier} Barrier`, value: `${data.Barrier}/${data.maxBarrier}`, inline: true }
                )
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });

        } else if (commandName === 'view') {
            const player = interaction.options.getUser('player') || interaction.user;
            const playerMember = await interaction.guild.members.fetch(player.id);
            
            initPlayer(player.id, playerMember.displayName);
            const data = playerData.get(player.id);

            const embed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle(`${data.characterName}'s Resources`)
                .addFields(
                    { name: `${RESOURCE_EMOJIS.HP} HP`, value: `${data.HP}/${data.maxHP}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.MP} MP`, value: `${data.MP}/${data.maxMP}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.IP} IP`, value: `${data.IP}/${data.maxIP}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.Armor} Armor`, value: `${data.Armor}/${data.maxArmor}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.Barrier} Barrier`, value: `${data.Barrier}/${data.maxBarrier}`, inline: true }
                )
                .setTimestamp();

            // Add status effects if any
            if (data.statusEffects && data.statusEffects.length > 0) {
                const statusText = data.statusEffects
                    .map(s => `**${s.name}** (${s.duration} turns)`)
                    .join('\n');
                embed.addFields({ name: '🔮 Status Effects', value: statusText, inline: false });
            }

            await interaction.reply({ embeds: [embed] });

        } else if (commandName === 'update') {
            const player = interaction.options.getUser('player') || interaction.user;
            const playerMember = await interaction.guild.members.fetch(player.id);
            const resource = interaction.options.getString('resource');
            const amount = interaction.options.getInteger('amount');

            initPlayer(player.id, playerMember.displayName);
            const data = playerData.get(player.id);
            
            const oldValue = data[resource];
            const maxValue = data[`max${resource}`];
            data[resource] += amount;
            const newValue = data[resource];

            saveData(); // Save after modification

            const embed = new EmbedBuilder()
                .setColor(amount > 0 ? 0x00FF00 : 0xFF0000)
                .setTitle(`${data.characterName}'s ${RESOURCE_EMOJIS[resource]} ${resource} Updated`)
                .setDescription(`${oldValue} ${amount > 0 ? '+' : ''}${amount} = **${newValue}/${maxValue}**`)
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });

        } else if (['hp', 'mp', 'ip', 'armor', 'barrier'].includes(commandName)) {
            const player = interaction.user;
            const playerMember = interaction.member;
            const resourceLower = commandName;
            // Map command names to proper resource names in data
            const resourceMap = {
                'hp': 'HP',
                'mp': 'MP',
                'ip': 'IP',
                'armor': 'Armor',
                'barrier': 'Barrier'
            };
            const resource = resourceMap[resourceLower];
            const amountStr = interaction.options.getString('amount');

            initPlayer(player.id, playerMember.displayName);
            const data = playerData.get(player.id);

            // Handle "full" command
            if (amountStr.toLowerCase() === 'full') {
                const oldValue = data[resource];
                const maxValue = data[`max${resource}`];
                data[resource] = maxValue;

                saveData(); // Save after modification

                const embed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle(`${data.characterName}'s ${RESOURCE_EMOJIS[resource]} ${resource} Restored!`)
                    .setDescription(`${oldValue}/${maxValue} → **${maxValue}/${maxValue}**`)
                    .setTimestamp();

                await interaction.reply({ embeds: [embed] });
                return;
            }

            // Handle "zero" command
            if (amountStr.toLowerCase() === 'zero') {
                const oldValue = data[resource];
                const maxValue = data[`max${resource}`];
                data[resource] = 0;

                saveData(); // Save after modification

                const embed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setTitle(`${data.characterName}'s ${RESOURCE_EMOJIS[resource]} ${resource} Set to Zero`)
                    .setDescription(`${oldValue}/${maxValue} → **0/${maxValue}**`)
                    .setTimestamp();

                await interaction.reply({ embeds: [embed] });
                return;
            }

            // Parse amount
            const amount = parseInt(amountStr);
            if (isNaN(amount)) {
                await interaction.reply({ content: 'Please enter a valid number, "full", or "zero"', ephemeral: true });
                return;
            }

            const oldValue = data[resource];
            const maxValue = data[`max${resource}`];
            data[resource] += amount;
            const newValue = data[resource];

            saveData(); // Save after modification

            const embed = new EmbedBuilder()
                .setColor(amount > 0 ? 0x00FF00 : 0xFF0000)
                .setTitle(`${data.characterName}'s ${RESOURCE_EMOJIS[resource]} ${resource} Updated`)
                .setDescription(`${oldValue} ${amount > 0 ? '+' : ''}${amount} = **${newValue}/${maxValue}**`)
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });

        } else if (commandName === 'rest') {
            const player = interaction.user;
            const playerMember = interaction.member;
            initPlayer(player.id, playerMember.displayName);
            const data = playerData.get(player.id);

            data.HP = data.maxHP;
            data.MP = data.maxMP;
            // IP stays as is
            data.Armor = data.maxArmor; // Set to full
            data.Barrier = data.maxBarrier; // Set to full

            saveData(); // Save after modification

            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle(`✨ ${data.characterName} Rested!`)
                .setDescription('HP, MP, Armor, and Barrier fully restored. IP stays.')
                .addFields(
                    { name: `${RESOURCE_EMOJIS.HP} HP`, value: `${data.HP}/${data.maxHP}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.MP} MP`, value: `${data.MP}/${data.maxMP}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.IP} IP`, value: `${data.IP}/${data.maxIP}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.Armor} Armor`, value: `${data.Armor}/${data.maxArmor}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.Barrier} Barrier`, value: `${data.Barrier}/${data.maxBarrier}`, inline: true }
                )
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });

        } else if (commandName === 'status') {
            const subcommand = interaction.options.getSubcommand();
            
            if (subcommand === 'add') {
                const player = interaction.options.getUser('player') || interaction.user;
                const playerMember = player.id === interaction.user.id 
                    ? interaction.member 
                    : await interaction.guild.members.fetch(player.id);
                const statusName = interaction.options.getString('name');
                const duration = interaction.options.getInteger('duration');

                initPlayer(player.id, playerMember.displayName);
                const data = playerData.get(player.id);

                // Check if status already exists
                const existingIndex = data.statusEffects.findIndex(s => s.name.toLowerCase() === statusName.toLowerCase());
                
                if (existingIndex !== -1) {
                    // Update existing status duration
                    data.statusEffects[existingIndex].duration = duration;
                    
                    saveData();

                    const embed = new EmbedBuilder()
                        .setColor(0xFFAA00)
                        .setTitle(`🔄 Status Updated`)
                        .setDescription(`**${statusName}** on ${data.characterName} updated to ${duration} turns`)
                        .setTimestamp();

                    await interaction.reply({ embeds: [embed] });
                } else {
                    // Add new status
                    data.statusEffects.push({ name: statusName, duration: duration });

                    saveData();

                    const embed = new EmbedBuilder()
                        .setColor(0xFF6B6B)
                        .setTitle(`✨ Status Applied`)
                        .setDescription(`**${statusName}** applied to ${data.characterName} for ${duration} turns`)
                        .setTimestamp();

                    await interaction.reply({ embeds: [embed] });
                }
            } else if (subcommand === 'clear') {
                const player = interaction.options.getUser('player') || interaction.user;
                const playerMember = player.id === interaction.user.id 
                    ? interaction.member 
                    : await interaction.guild.members.fetch(player.id);
                const statusName = interaction.options.getString('name');

                initPlayer(player.id, playerMember.displayName);
                const data = playerData.get(player.id);

                const index = data.statusEffects.findIndex(s => s.name.toLowerCase() === statusName.toLowerCase());

                if (index === -1) {
                    await interaction.reply({ content: `${data.characterName} doesn't have the status **${statusName}**`, ephemeral: true });
                    return;
                }

                data.statusEffects.splice(index, 1);

                saveData();

                const embed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle(`🗑️ Status Removed`)
                    .setDescription(`**${statusName}** removed from ${data.characterName}`)
                    .setTimestamp();

                await interaction.reply({ embeds: [embed] });
            }

        } else if (commandName === 'tick') {
            const player = interaction.options.getUser('player') || interaction.user;
            const playerMember = player.id === interaction.user.id 
                ? interaction.member 
                : await interaction.guild.members.fetch(player.id);
            
            initPlayer(player.id, playerMember.displayName);
            const data = playerData.get(player.id);

            if (!data.statusEffects || data.statusEffects.length === 0) {
                await interaction.reply({ content: `${data.characterName} has no status effects to tick.`, ephemeral: true });
                return;
            }

            const beforeCount = data.statusEffects.length;
            
            // Reduce all durations by 1
            data.statusEffects.forEach(status => {
                status.duration -= 1;
            });

            // Track expired statuses
            const expired = data.statusEffects.filter(s => s.duration <= 0);

            // Remove statuses with duration <= 0
            data.statusEffects = data.statusEffects.filter(s => s.duration > 0);
            
            const totalExpired = beforeCount - data.statusEffects.length;

            saveData(); // Save after modification

            const embed = new EmbedBuilder()
                .setColor(0x9B59B6)
                .setTitle(`⏰ ${data.characterName}'s Turn Advanced`)
                .setDescription(`All your status effect durations reduced by 1`)
                .setTimestamp();

            if (expired.length > 0) {
                const expiredText = expired.map(s => s.name).join(', ');
                embed.addFields({ name: '💨 Expired Status Effects', value: expiredText, inline: false });
            }

            if (data.statusEffects.length > 0) {
                const remainingText = data.statusEffects
                    .map(s => `**${s.name}** (${s.duration} turns)`)
                    .join('\n');
                embed.addFields({ name: '🔮 Remaining Status Effects', value: remainingText, inline: false });
            }

            embed.setFooter({ text: `${totalExpired} status effect(s) expired` });

            await interaction.reply({ embeds: [embed] });

        } else if (commandName === 'reset') {
            playerData.clear();
            
            // Clear database if using PostgreSQL
            if (useDatabase) {
                try {
                    await pool.query('DELETE FROM players');
                    console.log('✅ Cleared all players from database');
                } catch (error) {
                    console.error('❌ Error clearing database:', error);
                }
            }
            
            await saveData();
            
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('⚠️ All Player Data Reset')
                .setDescription('All player resources have been cleared.')
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });

        } else if (commandName === 'delete') {
            const player = interaction.options.getUser('player');
            
            if (!playerData.has(player.id)) {
                await interaction.reply({ content: `No data found for ${player.username}`, ephemeral: true });
                return;
            }

            const characterName = playerData.get(player.id).characterName;
            await deletePlayer(player.id);

            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('🗑️ Player Data Deleted')
                .setDescription(`All data for ${characterName} has been removed.`)
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });

        } else if (commandName === 'damage') {
            const damageAmount = interaction.options.getInteger('amount');
            const damageType = interaction.options.getString('type');
            const playersInput = interaction.options.getString('players');

            // Parse players from mentions or default to self
            let targetPlayers = [];
            if (playersInput) {
                const mentions = playersInput.match(/<@!?(\d+)>/g) || [];
                targetPlayers = mentions.map(m => m.match(/<@!?(\d+)>/)[1]);
            } else {
                targetPlayers = [interaction.user.id];
            }

            const results = [];
            const protectionResource = damageType === 'armor' ? 'Armor' : 'Barrier';

            for (const userId of targetPlayers) {
                try {
                    const playerMember = await interaction.guild.members.fetch(userId);
                    initPlayer(userId, playerMember.displayName);
                    const data = playerData.get(userId);

                    let remainingDamage = damageAmount;
                    let protectionUsed = 0;
                    let hpLost = 0;
                    
                    // First, reduce protection (Armor or Barrier)
                    if (data[protectionResource] > 0) {
                        if (data[protectionResource] >= remainingDamage) {
                            // Protection absorbs all damage
                            protectionUsed = remainingDamage;
                            data[protectionResource] -= remainingDamage;
                            remainingDamage = 0;
                        } else {
                            // Protection absorbs some, rest goes to HP
                            protectionUsed = data[protectionResource];
                            remainingDamage -= data[protectionResource];
                            data[protectionResource] = 0;
                        }
                    }

                    // Apply remaining damage to HP
                    if (remainingDamage > 0) {
                        hpLost = remainingDamage;
                        data.HP -= remainingDamage;
                    }

                    results.push({
                        name: data.characterName,
                        protectionUsed,
                        hpLost,
                        currentHP: data.HP,
                        maxHP: data.maxHP,
                        currentProtection: data[protectionResource],
                        maxProtection: data[`max${protectionResource}`]
                    });
                } catch (error) {
                    console.error(`Error processing player ${userId}:`, error);
                }
            }

            saveData();

            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle(`💥 ${damageAmount} Damage Applied!`)
                .setDescription(`Type: ${protectionResource}`)
                .setTimestamp();

            for (const result of results) {
                embed.addFields({
                    name: `${result.name}`,
                    value: `${RESOURCE_EMOJIS[protectionResource]} Absorbed: ${result.protectionUsed} | ${RESOURCE_EMOJIS.HP} Lost: ${result.hpLost}\n${RESOURCE_EMOJIS.HP} HP: ${result.currentHP}/${result.maxHP} | ${RESOURCE_EMOJIS[protectionResource]} ${protectionResource}: ${result.currentProtection}/${result.maxProtection}`,
                    inline: false
                });
            }

            await interaction.reply({ embeds: [embed] });

        } else if (commandName === 'attack') {
            const dice1 = interaction.options.getInteger('dice1');
            const dice2 = interaction.options.getInteger('dice2');
            const modifier = interaction.options.getInteger('modifier');
            const manualPenalties = interaction.options.getString('penalties');
            const player = interaction.user;
            const playerMember = interaction.member;

            initPlayer(player.id, playerMember.displayName);
            const data = playerData.get(player.id);
            const characterName = data.characterName;

            // Initialize penalty tracking if needed
            if (!attackPenalties.has(player.id)) {
                attackPenalties.set(player.id, { gate: 0, damageReduction: 0, blind: false });
            }

            // Increment attack counter
            const currentCount = (attackCounters.get(player.id) || 0) + 1;
            attackCounters.set(player.id, currentCount);

            // Get cumulative penalties
            const penalties = attackPenalties.get(player.id);

            // Check if needs penalty prompt (2nd+ attack without manual penalty)
            if (currentCount >= 2 && !manualPenalties) {
                // Show penalty selection buttons
                const currentPenaltiesText = [];
                if (penalties.gate > 0) currentPenaltiesText.push(`Gate +${penalties.gate}`);
                if (penalties.damageReduction > 0) currentPenaltiesText.push(`Modifier -${penalties.damageReduction}%`);
                if (penalties.blind) currentPenaltiesText.push(`Blind (Gate 3)`);
                
                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`penalty_attack_${player.id}_${dice1}_${dice2}_${modifier}_gate`)
                            .setLabel('🎯 Gate +1')
                            .setStyle(ButtonStyle.Primary),
                        new ButtonBuilder()
                            .setCustomId(`penalty_attack_${player.id}_${dice1}_${dice2}_${modifier}_damage50`)
                            .setLabel('⚔️ -50% Modifier')
                            .setStyle(ButtonStyle.Danger),
                        new ButtonBuilder()
                            .setCustomId(`penalty_attack_${player.id}_${dice1}_${dice2}_${modifier}_damage100`)
                            .setLabel('⚔️ No Modifier')
                            .setStyle(ButtonStyle.Danger),
                        new ButtonBuilder()
                            .setCustomId(`penalty_attack_${player.id}_${dice1}_${dice2}_${modifier}_blind`)
                            .setLabel('👁️ Blind (Gate 3)')
                            .setStyle(ButtonStyle.Secondary)
                            .setDisabled(penalties.blind) // Can only apply once
                    );

                let description = `**${characterName}**, choose ONE penalty to ADD:`;
                if (currentPenaltiesText.length > 0) {
                    description += `\n\n**Current Penalties:** ${currentPenaltiesText.join(', ')}`;
                }

                const embed = new EmbedBuilder()
                    .setColor(0xFFAA00)
                    .setTitle(`⚠️ Multi-Attack Penalty (${currentCount}${currentCount === 2 ? 'nd' : currentCount === 3 ? 'rd' : 'th'} Attack)`)
                    .setDescription(description)
                    .addFields(
                        { name: '🎯 Gate +1', value: 'Adds +1 to gate (cumulative)', inline: true },
                        { name: '⚔️ -50% Modifier', value: 'Reduces modifier by 50%', inline: true },
                        { name: '⚔️ No Modifier', value: 'Removes all modifier', inline: true },
                        { name: '👁️ Blind', value: 'Sets gate to 3 (max, once only)', inline: true }
                    )
                    .setFooter({ text: `Attack #${currentCount} • Penalties are cumulative` })
                    .setTimestamp();

                await interaction.reply({ embeds: [embed], components: [row] });
                return;
            }

            // Apply manual penalty if provided
            if (manualPenalties) {
                if (manualPenalties === 'gate') {
                    penalties.gate += 1;
                } else if (manualPenalties === 'damage50') {
                    penalties.damageReduction += 50;
                } else if (manualPenalties === 'damage100') {
                    penalties.damageReduction += 100;
                } else if (manualPenalties === 'blind') {
                    penalties.blind = true;
                }
            }

            // Calculate final gate (blind sets to 3, otherwise 1 + gate penalties)
            const gate = penalties.blind ? 3 : (1 + penalties.gate);
            const damageMultiplier = Math.max(0, 1 - (penalties.damageReduction / 100));
            const finalModifier = Math.floor(modifier * damageMultiplier);

            // Build penalty text
            const penaltyTexts = [];
            if (penalties.blind) penaltyTexts.push(`Blind (Gate 3)`);
            else if (penalties.gate > 0) penaltyTexts.push(`Gate +${penalties.gate}`);
            if (penalties.damageReduction > 0) penaltyTexts.push(`Modifier -${penalties.damageReduction}%`);
            const penaltyText = penaltyTexts.length > 0 ? penaltyTexts.join(', ') : 'None';

            // Roll the dice
            const roll1 = Math.floor(Math.random() * dice1) + 1;
            const roll2 = Math.floor(Math.random() * dice2) + 1;
            const total = roll1 + roll2;
            const highRoll = Math.max(roll1, roll2);
            const damage = highRoll + finalModifier;

            // Determine hit/miss/fumble/crit
            const isFumble = roll1 === 1 && roll2 === 1;
            const isCrit = !isFumble && roll1 === roll2 && roll1 > 5;
            const isHit = isFumble ? false : isCrit ? true : (roll1 > gate && roll2 > gate);

            // Build result text
            let resultText = `> **${characterName}** ⚔️ (Attack #${currentCount})\n`;
            if (penaltyText !== 'None') resultText += `> *Penalties: ${penaltyText}*\n`;
            resultText += `> \n`;
            resultText += `> d${dice1}: **${roll1}**  |  d${dice2}: **${roll2}**\n`;
            resultText += `> Total: ${total}  •  Gate: ≤${gate}\n`;
            resultText += `> \n`;
            resultText += `> HighRoll = **${highRoll}**\n`;
            if (penalties.damageReduction > 0) {
                resultText += `> Original: HR + ${modifier}\n`;
                resultText += `> Penalized: HR + ${finalModifier} = **${damage} damage**\n`;
            } else {
                resultText += `> HR + ${finalModifier} = **${damage} damage**\n`;
            }
            resultText += `> \n`;
            
            if (isFumble) {
                resultText += `> 💀 **FUMBLE!** (Auto-Fail)`;
            } else if (isCrit) {
                resultText += `> ⭐ **CRITICAL!** (Auto-Success)`;
            } else if (isHit) {
                resultText += `> ✅ **HIT** (Both dice > ${gate})`;
            } else {
                resultText += `> ❌ **MISS** (At least one die ≤ ${gate})`;
            }

            const embed = new EmbedBuilder()
                .setColor(isFumble ? 0x800000 : isCrit ? 0xFFD700 : isHit ? 0x00FF00 : 0xFF0000)
                .setTitle(`🎲 Attack Roll`)
                .setDescription(resultText)
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });

        } else if (commandName === 'cast') {
            const dice1 = interaction.options.getInteger('dice1');
            const dice2 = interaction.options.getInteger('dice2');
            const modifier = interaction.options.getInteger('modifier');
            const manualPenalties = interaction.options.getString('penalties');
            const player = interaction.user;
            const playerMember = interaction.member;

            initPlayer(player.id, playerMember.displayName);
            const data = playerData.get(player.id);
            const characterName = data.characterName;

            // Increment cast counter
            const currentCount = (castCounters.get(player.id) || 0) + 1;
            castCounters.set(player.id, currentCount);

            // Calculate MP penalty text only (no auto reduction)
            let mpPenaltyText = '';
            if (currentCount === 2) {
                mpPenaltyText = 'Multi-Cast Penalty: Extra 10 MP';
            } else if (currentCount >= 3) {
                mpPenaltyText = 'Multi-Cast Penalty: Extra 20 MP';
            }

            // Apply manual penalties only
            let gate = 1;
            let finalModifier = modifier;
            let penaltyText = '';

            if (manualPenalties) {
                if (manualPenalties === 'gate') {
                    gate = 2;
                    penaltyText = 'Gate +1';
                } else if (manualPenalties === 'damage50') {
                    finalModifier = Math.floor(modifier / 2);
                    penaltyText = 'Damage -50%';
                } else if (manualPenalties === 'damage100') {
                    finalModifier = 0;
                    penaltyText = 'Damage -100%';
                }
            }

            // Roll the dice
            const roll1 = Math.floor(Math.random() * dice1) + 1;
            const roll2 = Math.floor(Math.random() * dice2) + 1;
            const total = roll1 + roll2;
            const highRoll = Math.max(roll1, roll2);
            const damage = highRoll + finalModifier;

            // Determine hit/miss/fumble/crit
            const isFumble = roll1 === 1 && roll2 === 1;
            const isCrit = !isFumble && roll1 === roll2 && roll1 > 5;
            const isHit = isFumble ? false : isCrit ? true : (roll1 > gate && roll2 > gate);

            // Build result text
            let resultText = `> **${characterName}** ✨ (Cast #${currentCount})\n`;
            if (mpPenaltyText) resultText += `> *${mpPenaltyText}*\n`;
            if (penaltyText) resultText += `> *Penalty: ${penaltyText}*\n`;
            resultText += `> \n`;
            resultText += `> d${dice1}: **${roll1}**  |  d${dice2}: **${roll2}**\n`;
            resultText += `> Total: ${total}  •  Gate: ≤${gate}\n`;
            resultText += `> \n`;
            resultText += `> HighRoll = **${highRoll}**\n`;
            if (penaltyText.includes('Damage')) {
                resultText += `> Original: HR + ${modifier}\n`;
                resultText += `> Penalized: HR + ${finalModifier} = **${damage} damage**\n`;
            } else {
                resultText += `> HR + ${finalModifier} = **${damage} damage**\n`;
            }
            resultText += `> \n`;
            
            if (isFumble) {
                resultText += `> 💀 **FUMBLE!** (Auto-Fail)`;
            } else if (isCrit) {
                resultText += `> ⭐ **CRITICAL!** (Auto-Success)`;
            } else if (isHit) {
                resultText += `> ✅ **HIT** (Both dice > ${gate})`;
            } else {
                resultText += `> ❌ **MISS** (At least one die ≤ ${gate})`;
            }

            const embed = new EmbedBuilder()
                .setColor(isFumble ? 0x800000 : isCrit ? 0xFFD700 : isHit ? 0x00FF00 : 0xFF0000)
                .setTitle(`🎲 Cast Roll`)
                .setDescription(resultText)
                .setFooter({ text: `${RESOURCE_EMOJIS.MP} MP: ${data.MP}/${data.maxMP}` })
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });

        } else if (commandName === 'check') {
            const dice1 = interaction.options.getInteger('dice1');
            const dice2 = interaction.options.getInteger('dice2');
            const gate = interaction.options.getInteger('gate');
            const player = interaction.options.getUser('player') || interaction.user;
            const playerMember = player.id === interaction.user.id 
                ? interaction.member 
                : await interaction.guild.members.fetch(player.id);

            initPlayer(player.id, playerMember.displayName);
            const data = playerData.get(player.id);
            const characterName = data.characterName;

            // Roll the dice
            const roll1 = Math.floor(Math.random() * dice1) + 1;
            const roll2 = Math.floor(Math.random() * dice2) + 1;
            const total = roll1 + roll2;

            // Determine success/fail/fumble/crit
            const isFumble = roll1 === 1 && roll2 === 1;
            const isCrit = !isFumble && roll1 === roll2 && roll1 > 5;
            const isSuccess = isFumble ? false : isCrit ? true : (roll1 > gate && roll2 > gate);

            // Build result text
            let resultText = `> **${characterName}** 🎲\n`;
            resultText += `> \n`;
            resultText += `> d${dice1}: **${roll1}**  |  d${dice2}: **${roll2}**\n`;
            resultText += `> Total: ${total}  •  Gate: ≤${gate}\n`;
            resultText += `> \n`;
            
            if (isFumble) {
                resultText += `> 💀 **FUMBLE!** (Auto-Fail)`;
            } else if (isCrit) {
                resultText += `> ⭐ **CRITICAL SUCCESS!** (Auto-Success)`;
            } else if (isSuccess) {
                resultText += `> ✅ **SUCCESS** (Both dice > ${gate})`;
            } else {
                resultText += `> ❌ **FAIL** (At least one die ≤ ${gate})`;
            }

            const embed = new EmbedBuilder()
                .setColor(isFumble ? 0x800000 : isCrit ? 0xFFD700 : isSuccess ? 0x00FF00 : 0xFF0000)
                .setTitle(`🎲 Skill Check`)
                .setDescription(resultText)
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });

        } else if (commandName === 'turn') {
            if (!activeEncounter.active) {
                await interaction.reply({ content: 'No active clash. Use `/clash start` first.', ephemeral: true });
                return;
            }

            if (activeEncounter.combatants.length === 0) {
                await interaction.reply({ content: 'No combatants in the clash.', ephemeral: true });
                return;
            }

            // Reset attack and cast counters and penalties for all players
            attackCounters.clear();
            castCounters.clear();
            attackPenalties.clear();
            castPenalties.clear();

            // Refill Armor and Barrier for all combatants
            const refilled = [];
            const mentions = [];

            for (const userId of activeEncounter.combatants) {
                const data = playerData.get(userId);
                if (!data) continue;

                const oldArmor = data.Armor;
                const oldBarrier = data.Barrier;
                data.Armor = data.maxArmor;
                data.Barrier = data.maxBarrier;

                refilled.push({
                    name: data.characterName,
                    armorGain: data.maxArmor - oldArmor,
                    barrierGain: data.maxBarrier - oldBarrier,
                    currentArmor: data.Armor,
                    maxArmor: data.maxArmor,
                    currentBarrier: data.Barrier,
                    maxBarrier: data.maxBarrier
                });

                mentions.push(`<@${userId}>`);
            }

            await saveData();

            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('🔄 New Round Started!')
                .setDescription('All combatants\' Armor and Barrier have been refilled!\nAttack and Cast penalties reset!')
                .setTimestamp();

            for (const combatant of refilled) {
                embed.addFields({
                    name: `${combatant.name}`,
                    value: `${RESOURCE_EMOJIS.Armor} Armor: ${combatant.currentArmor}/${combatant.maxArmor} (+${combatant.armorGain})\n${RESOURCE_EMOJIS.Barrier} Barrier: ${combatant.currentBarrier}/${combatant.maxBarrier} (+${combatant.barrierGain})`,
                    inline: true
                });
            }

            await interaction.reply({ 
                content: mentions.join(' '),
                embeds: [embed] 
            });

        } else if (commandName === 'resetpenalty') {
            const type = interaction.options.getString('type');
            const player = interaction.options.getUser('player');

            if (type === 'attack') {
                attackCounters.delete(player.id);
                attackPenalties.delete(player.id);
            } else if (type === 'cast') {
                castCounters.delete(player.id);
                castPenalties.delete(player.id);
            }

            const playerMember = await interaction.guild.members.fetch(player.id);
            initPlayer(player.id, playerMember.displayName);
            const data = playerData.get(player.id);

            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('✅ Penalty Reset')
                .setDescription(`**${data.characterName}**'s ${type} penalty and counter have been reset to 0.`)
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });

        } else if (commandName === 'listall') {
            if (!activeEncounter.active) {
                await interaction.reply('No active encounter. Use `/startencounter` to begin.');
                return;
            }

            if (activeEncounter.combatants.length === 0) {
                await interaction.reply('No combatants in the current encounter. Use `/addcombatant` to add players.');
                return;
            }

            const embed = new EmbedBuilder()
                .setColor(0xFFFFFF)
                .setTitle('⚔️ Active Encounter - Combatants')
                .setTimestamp();

            for (const userId of activeEncounter.combatants) {
                const data = playerData.get(userId);
                if (!data) continue;

                let valueText = `${RESOURCE_EMOJIS.HP} HP: ${data.HP}/${data.maxHP} | ${RESOURCE_EMOJIS.MP} MP: ${data.MP}/${data.maxMP} | ${RESOURCE_EMOJIS.IP} IP: ${data.IP}/${data.maxIP} | ${RESOURCE_EMOJIS.Armor} Armor: ${data.Armor}/${data.maxArmor} | ${RESOURCE_EMOJIS.Barrier} Barrier: ${data.Barrier}/${data.maxBarrier}`;
                
                if (data.statusEffects && data.statusEffects.length > 0) {
                    const statusText = data.statusEffects
                        .map(s => `${s.name} (${s.duration})`)
                        .join(', ');
                    valueText += `\n🔮 ${statusText}`;
                }

                embed.addFields({
                    name: data.characterName,
                    value: valueText,
                    inline: false
                });
            }

            embed.setFooter({ text: `${activeEncounter.combatants.length} combatant(s) in encounter` });

            await interaction.reply({ embeds: [embed] });
        } else if (commandName === 'viewall') {
            if (playerData.size === 0) {
                await interaction.reply('No player data available yet.');
                return;
            }

            const embed = new EmbedBuilder()
                .setColor(0x9B59B6)
                .setTitle('📊 All Players - Resources Overview')
                .setTimestamp();

            for (const [userId, data] of playerData) {
                const resourceText = `${RESOURCE_EMOJIS.HP} **HP:** ${data.HP}/${data.maxHP}\n${RESOURCE_EMOJIS.MP} **MP:** ${data.MP}/${data.maxMP}\n${RESOURCE_EMOJIS.IP} **IP:** ${data.IP}/${data.maxIP}\n${RESOURCE_EMOJIS.Armor} **Armor:** ${data.Armor}/${data.maxArmor}\n${RESOURCE_EMOJIS.Barrier} **Barrier:** ${data.Barrier}/${data.maxBarrier}`;
                
                let fieldValue = resourceText;
                if (data.statusEffects && data.statusEffects.length > 0) {
                    const statusText = data.statusEffects
                        .map(s => `${s.name} (${s.duration})`)
                        .join(', ');
                    fieldValue += `\n🔮 ${statusText}`;
                }

                embed.addFields({
                    name: `👤 ${data.characterName}`,
                    value: fieldValue,
                    inline: true
                });
            }

            await interaction.reply({ embeds: [embed] });
        } else if (commandName === 'clash') {
            const subcommand = interaction.options.getSubcommand();

            if (subcommand === 'start') {
                if (activeEncounter.active) {
                    await interaction.reply({ content: 'A clash is already active! Use `/clash end` to end it first.', ephemeral: true });
                    return;
                }

                activeEncounter.active = true;
                activeEncounter.combatants = [];
                saveData();

                const embed = new EmbedBuilder()
                    .setColor(0xFF6B6B)
                    .setTitle('⚔️ Clash Started!')
                    .setDescription('Use `/clash add` to add players to this clash.\nUse `/clash list` to view active combatants.')
                    .setTimestamp();

                await interaction.reply({ embeds: [embed] });

            } else if (subcommand === 'end') {
                if (!activeEncounter.active) {
                    await interaction.reply({ content: 'No active clash to end.', ephemeral: true });
                    return;
                }

                const combatantCount = activeEncounter.combatants.length;
                activeEncounter.active = false;
                activeEncounter.combatants = [];
                saveData();

                const embed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle('✅ Clash Ended')
                    .setDescription(`Clash completed with ${combatantCount} combatant(s).`)
                    .setTimestamp();

                await interaction.reply({ embeds: [embed] });

            } else if (subcommand === 'add') {
                if (!activeEncounter.active) {
                    await interaction.reply({ content: 'No active clash. Use `/clash start` first.', ephemeral: true });
                    return;
                }

                const playersInput = interaction.options.getString('players');
                let targetPlayers = [];
                
                if (playersInput) {
                    const mentions = playersInput.match(/<@!?(\d+)>/g) || [];
                    targetPlayers = mentions.map(m => m.match(/<@!?(\d+)>/)[1]);
                } else {
                    targetPlayers = [interaction.user.id];
                }

                const added = [];
                const alreadyIn = [];
                const noData = [];

                for (const userId of targetPlayers) {
                    try {
                        const playerMember = await interaction.guild.members.fetch(userId);
                        
                        if (!playerData.has(userId)) {
                            noData.push(playerMember.displayName);
                            continue;
                        }

                        if (activeEncounter.combatants.includes(userId)) {
                            alreadyIn.push(playerData.get(userId).characterName);
                            continue;
                        }

                        activeEncounter.combatants.push(userId);
                        added.push(playerData.get(userId).characterName);
                    } catch (error) {
                        console.error(`Error adding player ${userId}:`, error);
                    }
                }

                saveData();

                let description = '';
                if (added.length > 0) description += `✅ Added: ${added.join(', ')}\n`;
                if (alreadyIn.length > 0) description += `⚠️ Already in: ${alreadyIn.join(', ')}\n`;
                if (noData.length > 0) description += `❌ No data: ${noData.join(', ')}`;

                const embed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle('➕ Players Added to Clash')
                    .setDescription(description || 'No players added')
                    .setTimestamp();

                await interaction.reply({ embeds: [embed] });

            } else if (subcommand === 'remove') {
                if (!activeEncounter.active) {
                    await interaction.reply({ content: 'No active clash.', ephemeral: true });
                    return;
                }

                const playersInput = interaction.options.getString('players');
                if (!playersInput) {
                    await interaction.reply({ content: 'Please mention at least one player to remove.', ephemeral: true });
                    return;
                }

                const mentions = playersInput.match(/<@!?(\d+)>/g) || [];
                const targetPlayers = mentions.map(m => m.match(/<@!?(\d+)>/)[1]);

                const removed = [];
                const notIn = [];

                for (const userId of targetPlayers) {
                    const index = activeEncounter.combatants.indexOf(userId);
                    if (index !== -1) {
                        activeEncounter.combatants.splice(index, 1);
                        const data = playerData.get(userId);
                        removed.push(data ? data.characterName : 'Unknown');
                    } else {
                        notIn.push('Player');
                    }
                }

                saveData();

                let description = '';
                if (removed.length > 0) description += `✅ Removed: ${removed.join(', ')}\n`;
                if (notIn.length > 0) description += `⚠️ Not in clash: ${notIn.length} player(s)`;

                const embed = new EmbedBuilder()
                    .setColor(0xFF6B6B)
                    .setTitle('➖ Players Removed from Clash')
                    .setDescription(description || 'No players removed')
                    .setTimestamp();

                await interaction.reply({ embeds: [embed] });

            } else if (subcommand === 'list') {
                if (!activeEncounter.active) {
                    await interaction.reply('No active clash. Use `/clash start` to begin.');
                    return;
                }

                if (activeEncounter.combatants.length === 0) {
                    await interaction.reply('No combatants in the current clash. Use `/clash add` to add players.');
                    return;
                }

                const embed = new EmbedBuilder()
                    .setColor(0xFFFFFF)
                    .setTitle('⚔️ Active Clash - Combatants')
                    .setTimestamp();

                for (const userId of activeEncounter.combatants) {
                    const data = playerData.get(userId);
                    if (!data) continue;

                    let valueText = `${RESOURCE_EMOJIS.HP} HP: ${data.HP}/${data.maxHP} | ${RESOURCE_EMOJIS.MP} MP: ${data.MP}/${data.maxMP} | ${RESOURCE_EMOJIS.IP} IP: ${data.IP}/${data.maxIP} | ${RESOURCE_EMOJIS.Armor} Armor: ${data.Armor}/${data.maxArmor} | ${RESOURCE_EMOJIS.Barrier} Barrier: ${data.Barrier}/${data.maxBarrier}`;
                    
                    if (data.statusEffects && data.statusEffects.length > 0) {
                        const statusText = data.statusEffects
                            .map(s => `${s.name} (${s.duration})`)
                            .join(', ');
                        valueText += `\n🔮 ${statusText}`;
                    }

                    embed.addFields({
                        name: data.characterName,
                        value: valueText,
                        inline: false
                    });
                }

                embed.setFooter({ text: `${activeEncounter.combatants.length} combatant(s) in clash` });

                await interaction.reply({ embeds: [embed] });
            }

        } else if (commandName === 'guide') {
            const embed = new EmbedBuilder()
                .setColor(0x00BFFF)
                .setTitle('📖 Bot Commands Guide')
                .setDescription('Complete list of available commands')
                .addFields(
                    { 
                        name: '🎮 Setup', 
                        value: '`/set @player name hp mp ip armor barrier` - Create/update (refills Armor/Barrier)\n`/delete @player` - Delete character data\n`/view [@player]` - View resources\n`/viewall` - View all players', 
                        inline: false 
                    },
                    { 
                        name: '⚡ Quick Updates', 
                        value: '`/hp <amount|full|zero>` - Update HP\n`/mp`, `/ip`, `/armor`, `/barrier` - Same for other resources\n`/rest` - Restore HP/MP/Armor/Barrier to full', 
                        inline: false 
                    },
                    { 
                        name: '💥 Combat', 
                        value: '`/damage <amt> <armor|barrier> [@players]` - Apply damage\n`/turn` - New round! Refills Armor/Barrier, resets penalties (GM only)', 
                        inline: false 
                    },
                    { 
                        name: '🎲 Attack/Cast System', 
                        value: '`/attack <d1> <d2> <mod> [penalty]` - Attack roll\n• Gate starts at 1\n• 2nd+ attack: Choose penalty (cumulative)\n• Penalties: Gate +1, -50% Mod, No Mod, Blind (Gate 3)\n• Fumble (1,1) = Auto-Fail | Crit (same, ≥6) = Auto-Success\n\n`/cast <d1> <d2> <mod> [penalty]` - Cast roll\n• 2nd cast: Extra 10 MP | 3rd+: Extra 20 MP\n• No automatic penalty prompts\n• Same crit/fumble rules', 
                        inline: false 
                    },
                    { 
                        name: '🎯 Penalty Details', 
                        value: '**Gate +1**: Increases gate by 1 (stackable)\n**-50% Modifier**: Reduces modifier by 50% (stackable)\n**No Modifier**: Sets modifier to 0\n**Blind**: Sets gate to 3 (max, once only)\n\nPenalties are **cumulative** and persist until `/turn` or `/resetpenalty`', 
                        inline: false 
                    },
                    { 
                        name: '🔮 Status & Checks', 
                        value: '`/status add <n> <duration> [@player]` - Add status\n`/status clear <n> [@player]` - Remove status\n`/tick [@player]` - Advance turn\n`/check <d1> <d2> <gate> [@player]` - Skill check', 
                        inline: false 
                    },
                    { 
                        name: '⚔️ Clash & GM Tools', 
                        value: '`/clash start|end|add|remove|list` - Manage encounters\n`/resetpenalty <attack|cast> @player` - Reset penalties (GM)\n`/turn` - New round (GM only)', 
                        inline: false 
                    },
                    { 
                        name: '📝 Examples', 
                        value: '`/attack 10 8 5` - 1st attack\n`/attack 10 8 5` - 2nd: Choose Gate +1 → Gate ≤2\n`/attack 10 8 5` - 3rd: Choose -50% Mod → Gate ≤2, Mod halved\n`/attack 10 8 5 blind` - Manual blind penalty', 
                        inline: false 
                    }
                )
                .setFooter({ text: 'Penalties stack! Gate +1 twice = Gate ≤3 | Two -50% = No modifier' })
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
        }
    } catch (error) {
        console.error(error);
        await interaction.reply({ content: 'An error occurred while processing the command.', ephemeral: true });
    }
});

// Handle button interactions for penalty choices
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    const [action, type, userId, dice1Str, dice2Str, modifierStr, penalty] = interaction.customId.split('_');
    
    if (action !== 'penalty' || type !== 'attack') return;

    // Only the player can click their penalty buttons
    if (interaction.user.id !== userId) {
        await interaction.reply({ content: 'This is not your penalty choice!', ephemeral: true });
        return;
    }

    const dice1 = parseInt(dice1Str);
    const dice2 = parseInt(dice2Str);
    const modifier = parseInt(modifierStr);

    initPlayer(userId, interaction.member.displayName);
    const data = playerData.get(userId);
    const characterName = data.characterName;

    // Get current count
    const currentCount = attackCounters.get(userId);

    // Add penalty cumulatively
    const penalties = attackPenalties.get(userId);
    if (penalty === 'gate') {
        penalties.gate += 1;
    } else if (penalty === 'damage50') {
        penalties.damageReduction += 50;
    } else if (penalty === 'damage100') {
        penalties.damageReduction += 100;
    } else if (penalty === 'blind') {
        penalties.blind = true;
    }

    // Calculate final values (blind sets gate to 3)
    let gate = penalties.blind ? 3 : (1 + penalties.gate);
    let damageMultiplier = 1 - (penalties.damageReduction / 100);
    const finalModifier = Math.floor(modifier * damageMultiplier);

    // Build cumulative penalty text
    const cumulativeParts = [];
    if (penalties.blind) cumulativeParts.push(`Blind (Gate 3)`);
    else if (penalties.gate > 0) cumulativeParts.push(`Gate +${penalties.gate}`);
    if (penalties.damageReduction > 0) cumulativeParts.push(`Modifier -${penalties.damageReduction}%`);
    const cumulativeText = cumulativeParts.join(', ');

    // Roll the dice
    const roll1 = Math.floor(Math.random() * dice1) + 1;
    const roll2 = Math.floor(Math.random() * dice2) + 1;
    const total = roll1 + roll2;
    const highRoll = Math.max(roll1, roll2);
    const damage = highRoll + finalModifier;

    // Determine hit/miss/fumble/crit
    const isFumble = roll1 === 1 && roll2 === 1;
    const isCrit = !isFumble && roll1 === roll2 && roll1 > 5;
    const isHit = isFumble ? false : isCrit ? true : (roll1 > gate && roll2 > gate);

    // Build result text
    let resultText = `> **${characterName}** ⚔️ (Attack #${currentCount})\n`;
    resultText += `> *Cumulative Penalties: ${cumulativeText}*\n`;
    resultText += `> \n`;
    resultText += `> d${dice1}: **${roll1}**  |  d${dice2}: **${roll2}**\n`;
    resultText += `> Total: ${total}  •  Gate: ≤${gate}\n`;
    resultText += `> \n`;
    resultText += `> HighRoll = **${highRoll}**\n`;
    if (damageMultiplier < 1) {
        resultText += `> Original: HR + ${modifier}\n`;
        resultText += `> Penalized: HR + ${finalModifier} = **${damage} damage**\n`;
    } else {
        resultText += `> HR + ${finalModifier} = **${damage} damage**\n`;
    }
    resultText += `> \n`;
    
    if (isFumble) {
        resultText += `> 💀 **FUMBLE!** (Auto-Fail)`;
    } else if (isCrit) {
        resultText += `> ⭐ **CRITICAL!** (Auto-Success)`;
    } else if (isHit) {
        resultText += `> ✅ **HIT** (Both dice > ${gate})`;
    } else {
        resultText += `> ❌ **MISS** (At least one die ≤ ${gate})`;
    }

    const embed = new EmbedBuilder()
        .setColor(isFumble ? 0x800000 : isCrit ? 0xFFD700 : isHit ? 0x00FF00 : 0xFF0000)
        .setTitle(`🎲 Attack Roll`)
        .setDescription(resultText)
        .setTimestamp();

    await interaction.update({ embeds: [embed], components: [] });
});

// Login to Discord
client.login(TOKEN);
