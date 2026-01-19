require('dotenv').config();

const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');

// Bot configuration
const TOKEN = process.env.DISCORD_BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE'; // Use environment variable
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '927071447300571137';

// File path for persistent storage
const DATA_FILE = path.join(__dirname, 'playerData.json');

// In-memory storage for player resources
let playerData = new Map();

// Active encounter data
let activeEncounter = {
    active: false,
    combatants: [] // Array of userIds
};

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

// Load data from file
function loadData() {
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

// Save data to file
function saveData() {
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
                    { name: 'Armor', value: 'armor' },
                    { name: 'Barrier', value: 'barrier' }
                ))
        .addStringOption(option =>
            option.setName('players')
                .setDescription('Players to damage (mention multiple: @player1 @player2, or leave empty for self)')
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName('attack')
        .setDescription('Roll attack dice with damage calculation')
        .addIntegerOption(option =>
            option.setName('maindice')
                .setDescription('Main dice size (e.g., 10 for d10)')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('subdice')
                .setDescription('Sub dice size (e.g., 8 for d8)')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('modifier')
                .setDescription('Damage modifier (added to HighRoll)')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('gate')
                .setDescription('Gate threshold (miss if main dice ≤ gate)')
                .setRequired(true)),

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
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
    console.log('Resource Tracker Bot is online!');
    loadData(); // Load saved data when bot starts
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

            // Set HP and MP to new max, keep IP, reset Armor and Barrier
            data.HP = newMaxHP;
            data.MP = newMaxMP;
            data.IP = currentIP; // Preserve current IP
            data.Armor = 0;
            data.Barrier = 0;

            data.username = playerMember.displayName;
            data.characterName = characterName;

            saveData(); // Save after modification

            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle(`✨ Max Resources Set for ${characterName}`)
                .setDescription('HP and MP restored to new max. IP preserved. Armor and Barrier reset to 0.')
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
            data.Armor = 0;
            data.Barrier = 0;

            saveData(); // Save after modification

            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle(`✨ ${data.characterName} Rested!`)
                .setDescription('HP and MP restored. IP stays. Armor and Barrier reset to 0.')
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
            saveData(); // Save after clearing
            
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('⚠️ All Player Data Reset')
                .setDescription('All player resources have been cleared and file deleted.')
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });

        } else if (commandName === 'delete') {
            const player = interaction.options.getUser('player');
            
            if (!playerData.has(player.id)) {
                await interaction.reply({ content: `No data found for ${player.username}`, ephemeral: true });
                return;
            }

            const characterName = playerData.get(player.id).characterName;
            playerData.delete(player.id);
            saveData();

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
            const mainDice = interaction.options.getInteger('maindice');
            const subDice = interaction.options.getInteger('subdice');
            const modifier = interaction.options.getInteger('modifier');
            const gate = interaction.options.getInteger('gate');

            // Roll the dice
            const mainRoll = Math.floor(Math.random() * mainDice) + 1;
            const subRoll = Math.floor(Math.random() * subDice) + 1;
            const total = mainRoll + subRoll;
            const highRoll = Math.max(mainRoll, subRoll);
            const damage = highRoll + modifier;

            // Determine hit/miss
            const isHit = mainRoll > gate;
            const isFumble = mainRoll === 1 && subRoll === 1;
            const isCrit = !isFumble && mainRoll === subRoll && mainRoll > 6;

            // Build result text
            let resultText = `> d${mainDice} (**${mainRoll}**), d${subDice} (**${subRoll}**) = **${total}**\n`;
            resultText += `> Gate ≤ ${gate}\n`;
            resultText += `> HR = ${highRoll}\n`;
            resultText += `> HR+${modifier} = **${damage} damage**\n`;
            resultText += `> \n`;
            
            if (isFumble) {
                resultText += `> **FUMBLE! ⚠️** (Both dice showed 1)`;
            } else if (isCrit) {
                resultText += `> **CRITICAL HIT! ✨** (Both dice: ${mainRoll})`;
            } else if (isHit) {
                resultText += `> **HIT ✅**`;
            } else {
                resultText += `> **MISS ❌**`;
            }

            const embed = new EmbedBuilder()
                .setColor(isFumble ? 0x800000 : isCrit ? 0xFFD700 : isHit ? 0x00FF00 : 0xFF0000)
                .setTitle(`🎲 Attack Roll`)
                .setDescription(resultText)
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
                        value: '`/set @player name hp mp ip armor barrier` - Create/update character\n`/delete @player` - Delete character data\n`/view [@player]` - View resources (self if empty)\n`/viewall` - View all players', 
                        inline: false 
                    },
                    { 
                        name: '⚡ Quick Updates', 
                        value: '`/hp <amount|full|zero>` - Update HP\n`/mp`, `/ip`, `/armor`, `/barrier` - Same for other resources\n`/rest` - Restore HP/MP, reset Armor/Barrier to 0', 
                        inline: false 
                    },
                    { 
                        name: '💥 Combat', 
                        value: '`/damage <amount> <armor|barrier> [@players]` - Apply damage (multi-target)\n`/attack <mainDice> <subDice> <modifier> <gate>` - Roll attack with HighRoll system', 
                        inline: false 
                    },
                    { 
                        name: '🔮 Status Effects', 
                        value: '`/status add <name> <duration> [@player]` - Add status\n`/status clear <name> [@player]` - Remove status\n`/tick [@player]` - Advance turn (reduce durations)', 
                        inline: false 
                    },
                    { 
                        name: '⚔️ Clash (Encounters)', 
                        value: '`/clash start` - Start encounter\n`/clash add [@players]` - Add to clash (self if empty)\n`/clash remove @players` - Remove from clash\n`/clash list` - View combatants\n`/clash end` - End encounter', 
                        inline: false 
                    },
                    { 
                        name: '🎲 Attack Roll Info', 
                        value: '**Gate**: Miss if main dice ≤ gate\n**HighRoll (HR)**: Higher of two dice\n**Damage**: HR + modifier\n**Fumble**: Both dice = 1\n**Crit**: Both dice same & >6', 
                        inline: false 
                    },
                    { 
                        name: '📝 Examples', 
                        value: '`/damage 15 armor @John @Sarah` - 15 damage to both\n`/attack 10 8 5 2` - d10+d8, +5 mod, gate 2\n`/hp -20` - Lose 20 HP\n`/status add Bleed 3` - Add Bleed for 3 turns', 
                        inline: false 
                    }
                )
                .setFooter({ text: 'Tip: Most commands default to yourself if @player is not specified' })
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
        }
    } catch (error) {
        console.error(error);
        await interaction.reply({ content: 'An error occurred while processing the command.', ephemeral: true });
    }
});

// Login to Discord
client.login(TOKEN);