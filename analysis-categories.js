// ============================================
// Commodity Classification & Categories
// Loaded before analysis.js
// ============================================

// User-defined classifications (persisted to localStorage)
let anlysCustomCats = {};
try { anlysCustomCats = JSON.parse(localStorage.getItem('mf_analysis_cats') || '{}'); } catch (e) {}
function anlysSaveCustomCats() { localStorage.setItem('mf_analysis_cats', JSON.stringify(anlysCustomCats)); }

// XP ingredients (Basic + Advanced Cauldron recipes + factory infrastructure)
const ANLYS_XP_ITEMS = new Set([
    // Crops — Basic & Advanced Cauldron
    'Potato', 'Melon', 'Melon Slice', 'Carrot', 'Cocoa Beans',
    'Wheat', 'Pumpkin', 'Cactus', 'Sugar Cane', 'Beetroot',
    'Sweet Berries', 'Bamboo', 'Kelp', 'Nether Wart',
    'Vines', 'Twisting Vines', 'Weeping Vines',
    'Crimson Stem', 'Warped Stem',
    'Red Mushroom', 'Brown Mushroom',
    // Saplings
    'Oak Sapling', 'Spruce Sapling', 'Birch Sapling', 'Jungle Sapling',
    // Secondary ingredients
    'Glass Bottle', 'Coal', 'Bone', 'Raw Copper',
    'Redstone Dust', 'Spider Eye', 'Gunpowder',
    'Lapis Lazuli', 'Rotten Flesh', 'Blaze Rod',
    'Nether Quartz', 'Eye of Ender',
    // Infrastructure (factory fuel, compactor, cauldron upgrade)
    'Charcoal', 'Crate', 'Wither Skeleton Skull',
    // XP output
    'Bottle o\' Enchanting', 'Experience Bottle',
]);

// Currency
const ANLYS_CURRENCY_ITEMS = new Set([
    'Diamond', 'Diamond Block', 'Block of Diamond',
    'Iron Ingot', 'Iron Block', 'Block of Iron',
    'Emerald', 'Emerald Block', 'Block of Emerald',
]);

// Explicit building materials
const ANLYS_BUILDING_ITEMS = new Set([
    'Stone', 'Cobblestone', 'Mossy Cobblestone',
    'Granite', 'Diorite', 'Andesite',
    'Polished Granite', 'Polished Diorite', 'Polished Andesite',
    'Deepslate', 'Cobbled Deepslate', 'Polished Deepslate',
    'Tuff', 'Calcite', 'Dripstone Block', 'Pointed Dripstone',
    'Sandstone', 'Red Sandstone', 'Smooth Sandstone', 'Smooth Red Sandstone',
    'Sand', 'Red Sand', 'Gravel', 'Clay Ball', 'Clay',
    'Brick', 'Nether Brick', 'Nether Bricks', 'Stone Bricks', 'Mossy Stone Bricks',
    'Cracked Stone Bricks', 'Chiseled Stone Bricks',
    'Prismarine', 'Dark Prismarine', 'Prismarine Bricks',
    'Sea Lantern', 'End Stone', 'End Stone Bricks', 'Purpur Block', 'Purpur Pillar',
    'Quartz Block', 'Smooth Quartz', 'Chiseled Quartz Block',
    'Obsidian', 'Crying Obsidian',
    'Netherrack', 'Basalt', 'Polished Basalt', 'Smooth Basalt',
    'Blackstone', 'Polished Blackstone', 'Polished Blackstone Bricks',
    'Soul Sand', 'Soul Soil', 'Magma Block',
    'Glowstone', 'Shroomlight', 'Torch', 'Lantern', 'Soul Lantern', 'Soul Torch',
    'Chain', 'Ladder', 'Scaffolding',
    'Glass', 'Glass Pane', 'Tinted Glass',
    'Iron Bars', 'Hay Block', 'Dried Kelp Block',
    'Honeycomb Block', 'Honey Block', 'Slime Block',
    'Bookshelf', 'Lectern', 'Flower Pot',
    'Painting', 'Item Frame', 'Glow Item Frame',
    'Campfire', 'Soul Campfire', 'Bell', 'Lodestone',
    'Chest', 'Barrel', 'Shulker Box',
    'Note Block', 'Jukebox', 'Anvil',
    'Redstone Block', 'Block of Redstone',
    'Lapis Block', 'Block of Lapis Lazuli', 'Lapis Lazuli Block',
    'Copper Block', 'Block of Copper',
    'Raw Iron Block', 'Block of Raw Iron',
    'Raw Gold Block', 'Block of Raw Gold',
    'Raw Copper Block', 'Block of Raw Copper',
]);

// Pattern-based matching
const ANLYS_TOOLS_PATTERNS = [
    /Sword$/, /Pickaxe$/, /(?<!\w)Axe$/, /Shovel$/, /Hoe$/,
    /Helmet$/, /Chestplate$/, /Leggings$/, /Boots$/,
    /^Bow$/, /^Crossbow$/, /^Shield$/, /^Trident$/,
    /^Fishing Rod$/, /^Shears$/, /^Flint and Steel$/,
    /^Elytra$/, /^Arrow/, /^Enchanted Book/,
    /Horse Armor$/, /^Saddle$/, /^Lead$/, /^Name Tag$/,
    /^Spyglass$/, /^Compass$/, /^Clock$/,
    /^Turtle Helmet$/, /^Totem of Undying$/,
];

const ANLYS_BUILDING_PATTERNS = [
    /Slab$/, /Stairs$/, / Wall$/, /Fence$/, / Gate$/,
    /Planks$/, / Log$/, / Wood$/, / Button$/, /Door$/,
    /Pressure Plate$/, /Trapdoor$/, / Sign$/,
    /Terracotta/, /Concrete/, /Carpet$/,
    /Wool$/, /Banner$/,
    /^Stripped /, /^Stained /, /^Waxed /,
    /^Rail$/, /Powered Rail/, /Detector Rail/, /Activator Rail/,
    /Candle$/, /^Copper /, /^Cut Copper/,
];

// Lore items — explicit + catch-all for unknown materials
const ANLYS_LORE_ITEMS = new Set([
    'Written Book', 'Writable Book', 'Filled Map', 'Map',
    'Knowledge Book', 'Bundle', 'Player Head',
]);

// Known Minecraft materials — anything NOT in this set and not matching patterns = Lore
const ANLYS_KNOWN_MATERIALS = new Set([
    ...ANLYS_XP_ITEMS, ...ANLYS_CURRENCY_ITEMS, ...ANLYS_BUILDING_ITEMS, ...ANLYS_LORE_ITEMS,
    // Misc items that are real MC items but don't fit neatly
    'Gold Ingot', 'Gold Block', 'Block of Gold', 'Gold Nugget',
    'Raw Gold', 'Raw Iron', 'Copper Ingot',
    'Ancient Debris', 'Netherite Scrap', 'Netherite Ingot', 'Netherite Block',
    'Amethyst Shard', 'Amethyst Cluster',
    'Nether Star', 'Shulker Shell', 'Heart of the Sea',
    'Sponge', 'Wet Sponge', 'Glowstone Dust',
    'Prismarine Shard', 'Prismarine Crystals',
    'String', 'Ender Pearl', 'Blaze Powder', 'Ghast Tear', 'Magma Cream',
    'Slime Ball', 'Phantom Membrane', 'Ink Sac', 'Glow Ink Sac',
    'Feather', 'Leather', 'Rabbit Hide', 'Rabbit Foot',
    'Apple', 'Golden Apple', 'Enchanted Golden Apple', 'Golden Carrot',
    'Stick', 'Flint', 'Bowl', 'Book', 'Paper', 'Sugar',
    'Honeycomb', 'Honey Bottle', 'Egg', 'Turtle Egg',
    'Bone Meal', 'Bone Block', 'Fermented Spider Eye', 'Glistering Melon Slice',
    'Fire Charge', 'TNT', 'Firework Rocket', 'Firework Star',
    'Dye', 'White Dye', 'Black Dye', 'Red Dye', 'Blue Dye', 'Yellow Dye', 'Green Dye',
    'Cyan Dye', 'Magenta Dye', 'Light Blue Dye', 'Light Gray Dye', 'Gray Dye',
    'Orange Dye', 'Pink Dye', 'Lime Dye', 'Brown Dye', 'Purple Dye',
    'Lily Pad', 'Sea Pickle', 'Lily of the Valley', 'Poppy', 'Dandelion',
    'Blue Orchid', 'Allium', 'Azure Bluet', 'Cornflower', 'Oxeye Daisy',
    'Sunflower', 'Lilac', 'Rose Bush', 'Peony', 'Wither Rose', 'Torchflower',
    'Chorus Fruit', 'Chorus Flower', 'Popped Chorus Fruit',
    'Bread', 'Cookie', 'Cake', 'Pumpkin Pie', 'Beetroot Soup', 'Mushroom Stew',
    'Cooked Beef', 'Cooked Porkchop', 'Cooked Chicken', 'Cooked Mutton',
    'Cooked Salmon', 'Cooked Cod', 'Cooked Rabbit',
    'Raw Beef', 'Raw Porkchop', 'Raw Chicken', 'Raw Mutton', 'Raw Rabbit',
    'Salmon', 'Cod', 'Tropical Fish', 'Pufferfish',
    'Nether Gold Ore', 'Nether Quartz Ore',
    'Lava Bucket', 'Water Bucket', 'Milk Bucket', 'Bucket',
    'Minecart', 'Hopper', 'Hopper Minecart', 'Chest Minecart',
    'Piston', 'Sticky Piston', 'Observer', 'Dropper', 'Dispenser',
    'Repeater', 'Comparator', 'Redstone Torch', 'Lever', 'Tripwire Hook',
    'Daylight Detector', 'Target', 'Redstone Lamp',
    'Brewing Stand', 'Cauldron', 'Furnace', 'Blast Furnace', 'Smoker',
    'Crafting Table', 'Stonecutter', 'Grindstone', 'Smithing Table', 'Loom',
    'Cartography Table', 'Fletching Table', 'Composter', 'Beehive',
    'Respawn Anchor', 'Lodestone', 'Conduit', 'Beacon',
    'Ender Chest', 'End Crystal', 'End Rod',
    'Acacia Sapling', 'Dark Oak Sapling', 'Mangrove Propagule', 'Cherry Sapling',
    'Acacia Leaves', 'Dark Oak Leaves', 'Oak Leaves', 'Spruce Leaves',
    'Birch Leaves', 'Jungle Leaves', 'Mangrove Leaves', 'Cherry Leaves', 'Azalea Leaves',
    'Acacia Log', 'Dark Oak Log', 'Oak Log', 'Spruce Log', 'Birch Log',
    'Jungle Log', 'Mangrove Log', 'Cherry Log',
    'Vine', 'Glow Berries', 'Glow Lichen', 'Moss Block', 'Moss Carpet',
    'Hanging Roots', 'Spore Blossom', 'Dripleaf',
    'Grass Block', 'Dirt', 'Coarse Dirt', 'Rooted Dirt', 'Podzol', 'Mycelium', 'Mud',
    'Farmland', 'Dirt Path', 'Snow', 'Snow Block', 'Ice', 'Packed Ice', 'Blue Ice',
    'Cobweb', 'Spawner', 'Infested Stone',
    'Vault Bastion', 'City Bastion',
]);

// Ore & raw minerals
const ANLYS_ORE_ITEMS = new Set([
    'Diamond', 'Diamond Block', 'Block of Diamond',
    'Iron Ingot', 'Iron Block', 'Block of Iron', 'Raw Iron',
    'Raw Gold', 'Raw Copper', 'Copper Ingot', 'Copper Block', 'Block of Copper',
    'Emerald', 'Emerald Block', 'Block of Emerald',
    'Gold Ingot', 'Gold Block', 'Block of Gold', 'Gold Nugget',
    'Redstone Dust', 'Redstone Block', 'Block of Redstone',
    'Lapis Lazuli', 'Lapis Block', 'Block of Lapis Lazuli', 'Lapis Lazuli Block',
    'Nether Quartz', 'Quartz Block',
    'Coal', 'Coal Block',
    'Amethyst Shard', 'Amethyst Cluster',
    'Ancient Debris', 'Netherite Scrap', 'Netherite Ingot', 'Netherite Block',
    'Nether Star', 'Nether Gold Ore', 'Nether Quartz Ore',
]);

// Aesthetics — decorative / cosmetic items
const ANLYS_AESTHETICS_ITEMS = new Set([
    'Flower Pot', 'Painting', 'Item Frame', 'Glow Item Frame',
    'Candle', 'White Candle', 'Red Candle', 'Blue Candle', 'Green Candle',
    'Yellow Candle', 'Orange Candle', 'Purple Candle', 'Pink Candle',
    'Light Blue Candle', 'Lime Candle', 'Cyan Candle', 'Magenta Candle',
    'Gray Candle', 'Light Gray Candle', 'Brown Candle', 'Black Candle',
    'Lantern', 'Soul Lantern', 'Chain',
    'Armor Stand', 'Head', 'Player Head',
    'Bell', 'Decorated Pot',
    'Glow Lichen', 'Moss Carpet', 'Spore Blossom', 'Hanging Roots',
    'Sea Pickle', 'Turtle Egg',
    'Lightning Rod',
]);
const ANLYS_AESTHETICS_PATTERNS = [
    /^.*Dye$/, /^.*Banner$/, /^.*Carpet$/, /^.*Candle$/,
    /^.*Head$/, /^.*Skull$/,
    /^.*Pottery Sherd$/, /^Decorated Pot/,
];

// Food — edible items
const ANLYS_FOOD_ITEMS = new Set([
    'Bread', 'Cookie', 'Cake', 'Pumpkin Pie', 'Beetroot Soup', 'Mushroom Stew',
    'Cooked Beef', 'Cooked Porkchop', 'Cooked Chicken', 'Cooked Mutton',
    'Cooked Salmon', 'Cooked Cod', 'Cooked Rabbit',
    'Raw Beef', 'Raw Porkchop', 'Raw Chicken', 'Raw Mutton', 'Raw Rabbit',
    'Salmon', 'Cod', 'Tropical Fish', 'Pufferfish',
    'Apple', 'Golden Apple', 'Enchanted Golden Apple',
    'Melon Slice', 'Sweet Berries', 'Glow Berries',
    'Baked Potato', 'Potato', 'Carrot', 'Beetroot',
    'Dried Kelp', 'Honey Bottle', 'Rabbit Stew',
    'Suspicious Stew', 'Golden Carrot',
    'Spider Eye', 'Rotten Flesh', 'Chorus Fruit',
]);

// Raw materials — natural resources, not processed
const ANLYS_RAW_ITEMS = new Set([
    'Sand', 'Red Sand', 'Gravel', 'Clay Ball', 'Clay',
    'Granite', 'Diorite', 'Andesite',
    'Deepslate', 'Tuff', 'Calcite',
    'Netherrack', 'Soul Sand', 'Soul Soil',
    'Basalt', 'Blackstone', 'Magma Block',
    'End Stone', 'Obsidian', 'Crying Obsidian',
    'Prismarine', 'Prismarine Shard', 'Prismarine Crystals',
    'Cobblestone', 'Stone', 'Dirt', 'Coarse Dirt', 'Rooted Dirt',
    'Podzol', 'Mycelium', 'Mud', 'Grass Block',
    'Ice', 'Packed Ice', 'Blue Ice', 'Snow', 'Snow Block',
    'Glowstone', 'Glowstone Dust',
    'Bone Meal', 'Slime Ball', 'Magma Cream',
    'Ink Sac', 'Glow Ink Sac', 'Feather', 'Leather',
    'Rabbit Hide', 'Rabbit Foot', 'Phantom Membrane',
    'String', 'Gunpowder', 'Bone', 'Ender Pearl',
    'Ghast Tear', 'Blaze Rod', 'Blaze Powder',
    'Shulker Shell', 'Heart of the Sea', 'Sponge', 'Wet Sponge',
    'Egg', 'Honeycomb', 'Stick',
]);

function anlysGetCategory(commodity) {
    const name = commodity.replace(/ \[.*\]$/, '');
    // Check user overrides first
    if (anlysCustomCats[name]?.cat) return anlysCustomCats[name].cat;
    if (ANLYS_XP_ITEMS.has(name)) return 'xp';
    if (ANLYS_CURRENCY_ITEMS.has(name)) return 'currency';
    if (ANLYS_ORE_ITEMS.has(name)) return 'ore';
    if (ANLYS_FOOD_ITEMS.has(name)) return 'food';
    if (ANLYS_LORE_ITEMS.has(name)) return 'lore';
    if (ANLYS_AESTHETICS_ITEMS.has(name)) return 'aesthetics';
    for (const p of ANLYS_AESTHETICS_PATTERNS) { if (p.test(name)) return 'aesthetics'; }
    if (ANLYS_RAW_ITEMS.has(name)) return 'raw';
    if (ANLYS_BUILDING_ITEMS.has(name)) return 'building';
    for (const p of ANLYS_TOOLS_PATTERNS) { if (p.test(name)) return 'tools'; }
    for (const p of ANLYS_BUILDING_PATTERNS) { if (p.test(name)) return 'building'; }
    // If not a known MC material, probably a lore/custom item
    if (!ANLYS_KNOWN_MATERIALS.has(name) && !ANLYS_BUILDING_PATTERNS.some(p => p.test(name))) return 'lore';
    return null;
}

// Farmable classification
const ANLYS_FARMABLE = new Set([
    // Crops
    'Potato', 'Melon', 'Melon Slice', 'Carrot', 'Cocoa Beans',
    'Wheat', 'Pumpkin', 'Cactus', 'Sugar Cane', 'Beetroot',
    'Sweet Berries', 'Bamboo', 'Kelp', 'Nether Wart',
    'Vines', 'Twisting Vines', 'Weeping Vines',
    'Crimson Stem', 'Warped Stem',
    'Red Mushroom', 'Brown Mushroom',
    // Wood & saplings
    'Oak Log', 'Spruce Log', 'Birch Log', 'Jungle Log', 'Acacia Log',
    'Dark Oak Log', 'Mangrove Log', 'Cherry Log',
    'Oak Sapling', 'Spruce Sapling', 'Birch Sapling', 'Jungle Sapling',
    'Acacia Sapling', 'Dark Oak Sapling', 'Mangrove Propagule', 'Cherry Sapling',
    'Oak Leaves', 'Spruce Leaves', 'Birch Leaves', 'Jungle Leaves',
    'Acacia Leaves', 'Dark Oak Leaves',
    // Mob drops (confirmed farmable by user)
    'Bone', 'Bone Meal', 'Spider Eye', 'Gunpowder', 'Rotten Flesh',
    'Blaze Rod', 'Blaze Powder', 'String', 'Ender Pearl',
    'Ghast Tear', 'Magma Cream', 'Slime Ball',
    'Phantom Membrane', 'Ink Sac', 'Glow Ink Sac',
    'Feather', 'Leather', 'Rabbit Hide', 'Rabbit Foot',
    'Wither Skeleton Skull',
    // Farmable minerals/materials
    'Gold Ingot', 'Gold Block', 'Block of Gold', 'Gold Nugget',
    'Charcoal', 'Glass Bottle',
    'Cobblestone', 'Stone', // cobble gens
    'Apple', 'Stick',
    'Honeycomb', 'Honey Bottle', 'Egg',
]);

const ANLYS_NONFARMABLE = new Set([
    // Ores & minerals
    'Diamond', 'Diamond Block', 'Block of Diamond',
    'Iron Ingot', 'Iron Block', 'Block of Iron', 'Raw Iron',
    'Raw Gold', 'Raw Copper', 'Copper Ingot', 'Copper Block', 'Block of Copper',
    'Emerald', 'Emerald Block', 'Block of Emerald',
    'Redstone Dust', 'Redstone Block', 'Block of Redstone',
    'Lapis Lazuli', 'Lapis Block', 'Block of Lapis Lazuli', 'Lapis Lazuli Block',
    'Nether Quartz', 'Quartz Block',
    'Coal', 'Coal Block',
    'Amethyst Shard', 'Amethyst Cluster',
    // Netherite chain
    'Ancient Debris', 'Netherite Scrap', 'Netherite Ingot', 'Netherite Block',
    // Rare/unique
    'Nether Star', 'Shulker Shell', 'Heart of the Sea',
    'Sponge', 'Wet Sponge', 'Eye of Ender',
    // Natural blocks (require mining)
    'Sand', 'Red Sand', 'Gravel', 'Clay Ball', 'Clay',
    'Granite', 'Diorite', 'Andesite',
    'Deepslate', 'Tuff', 'Calcite',
    'Netherrack', 'Soul Sand', 'Soul Soil',
    'Basalt', 'Blackstone', 'Magma Block',
    'End Stone', 'Obsidian', 'Crying Obsidian',
    'Glowstone', 'Glowstone Dust',
    'Prismarine', 'Prismarine Shard', 'Prismarine Crystals',
    'Nether Gold Ore', 'Nether Quartz Ore',
]);

const ANLYS_NONFARMABLE_PATTERNS = [/Banner$/];

function anlysIsFarmable(commodity) {
    const name = commodity.replace(/ \[.*\]$/, '');
    // Check user overrides first
    if (anlysCustomCats[name]?.farm !== undefined) return anlysCustomCats[name].farm;
    if (ANLYS_FARMABLE.has(name)) return true;
    if (ANLYS_NONFARMABLE.has(name)) return false;
    for (const p of ANLYS_NONFARMABLE_PATTERNS) { if (p.test(name)) return false; }
    return null;
}

const ANLYS_CAT_LABELS = {
    xp: 'XP', building: 'BLD', tools: 'T&A', currency: 'CUR', lore: 'LORE',
    aesthetics: 'AES', ore: 'ORE', food: 'FOOD', raw: 'RAW'
};
const ANLYS_CAT_COLORS = {
    xp: '#6c6', building: '#8ac', tools: '#c8a', currency: '#dd6', lore: '#999',
    aesthetics: '#d8a', ore: '#c96', food: '#e88', raw: '#ab8'
};
