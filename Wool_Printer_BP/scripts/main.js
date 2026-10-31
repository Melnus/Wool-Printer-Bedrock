import { world, system, BlockPermutation } from "@minecraft/server"

// ============================================================
//  Wool Printer
//  羊毛・コンクリートで描いた断面を、中心核の色に応じた長さだけ奥へ押し出してブロック化する
//  発動(押し出し): 中心核の羊毛に「蛍光イカスミ」を使う / 向き: 使った面の反対側
//  発動(球): 中心核の羊毛に「イカスミ」を使う / スニーク時: 核を頂点とする半球
//  アンドゥ: 「ブラシ」をどれかのブロックに使うと、直前の印刷を元に戻す(怪しげな砂・砂利はバニラの発掘を優先して横取りしない)
//  対応表: 「本」を羊毛・コンクリートに使うと、色 -> ブロックの対応表をチャットに表示する
//  文言はリソースパックの .lang キー経由 (i18n: ja_JP / en_US)
// ============================================================

// 中心核の色 -> 長さ(マス)
const CORE_LENGTH = {
    "minecraft:pink_wool": 30,
    "minecraft:magenta_wool": 50,
    "minecraft:red_wool": 100
}

// 色ブロック(羊毛・コンクリート) -> 印刷するブロック。ここに足せば増やせる。
// 載っていない色は UNMAPPED_BLOCK(空気)として印刷する。
const COLOR_TO_BLOCK = {
    // --- 羊毛 ---
    "minecraft:purple_wool": "minecraft:pearlescent_froglight",
    "minecraft:yellow_wool": "minecraft:ochre_froglight",
    "minecraft:green_wool": "minecraft:verdant_froglight",
    "minecraft:light_blue_wool": "minecraft:sea_lantern",
    "minecraft:orange_wool": "minecraft:waxed_copper",
    "minecraft:blue_wool": "minecraft:water",
    "minecraft:cyan_wool": "minecraft:blue_ice",
    "minecraft:white_wool": "minecraft:glass",
    "minecraft:light_gray_wool": "minecraft:stone_bricks",
    "minecraft:gray_wool": "minecraft:tuff_bricks",
    "minecraft:black_wool": "minecraft:deepslate_bricks",
    "minecraft:brown_wool": "minecraft:waxed_copper_grate",
    "minecraft:lime_wool": "minecraft:air",
    // 中心核の色(核の位置は空気。球モードでは最頻ブロックに置き換わる)
    "minecraft:pink_wool": "minecraft:air",
    "minecraft:magenta_wool": "minecraft:air",
    "minecraft:red_wool": "minecraft:air",
    // --- コンクリート ---
    "minecraft:white_concrete": "minecraft:quartz_bricks",
    "minecraft:light_gray_concrete": "minecraft:nether_brick",
    "minecraft:brown_concrete": "minecraft:soul_sand",
    "minecraft:blue_concrete": "minecraft:prismarine_bricks",
    "minecraft:black_concrete": "minecraft:obsidian",
    "minecraft:lime_concrete": "minecraft:slime",
    "minecraft:red_concrete": "minecraft:redstone_block",
    "minecraft:orange_concrete": "minecraft:magma"
}

const UNMAPPED_BLOCK = "minecraft:air"  // 対応表にない色のブロック

const MAX_RADIUS = 12      // 核から各方向に調べる最大マス数(最大 25×25)
const SLICES_PER_TICK = 10 // 押し出しで1tickに印刷する奥行き

// 球モード設定
const SHELL_THICKNESS = 2       // 殻の厚み。0 = 中身あり、1以上で中空になる(水中では1だと滴るので2が既定)
const BLOCKS_PER_TICK = 256     // 球モードで1tickに置くブロック数
const UNDO_BLOCKS_PER_TICK = 256

// 使った面の「反対側」へ伸ばす
const PRINT_DIRECTION = {
    North: { x: 0, y: 0, z: 1 },
    South: { x: 0, y: 0, z: -1 },
    West: { x: 1, y: 0, z: 0 },
    East: { x: -1, y: 0, z: 0 },
    Up: { x: 0, y: -1, z: 0 },
    Down: { x: 0, y: 1, z: 0 }
}

const isPattern = (id) => typeof id === "string" && (id.endsWith("_wool") || id.endsWith("_concrete"))

// i18n: 文言はリソースパックの texts/*.lang のキーで引く (プレイヤーの言語設定で解決される)
function msg(player, key, args) {
    try {
        const comp = { translate: key }
        if (args) comp.with = args
        player.sendMessage({ rawtext: [comp] })
    } catch (e) { }
}

// 断面を作る2軸(押し出し方向 d に対して垂直な平面)
function planeAxes(d) {
    if (d.x !== 0) return { a: { x: 0, y: 1, z: 0 }, b: { x: 0, y: 0, z: 1 } }
    if (d.y !== 0) return { a: { x: 1, y: 0, z: 0 }, b: { x: 0, y: 0, z: 1 } }
    return { a: { x: 1, y: 0, z: 0 }, b: { x: 0, y: 1, z: 0 } }
}

// ============================================================
//  アンドゥ記録: プレイヤーごとに直近1件の印刷だけを保持する
//  印刷前に元のブロックを記録し、ブラシで復元する
// ============================================================
const undoByPlayer = new Map() // name -> { dimension, entries: Map<key, {x,y,z,perm}>, minP, maxP }

function newUndoRecord(player, dimension) {
    const rec = {
        dimension,
        entries: new Map(),
        minP: { x: Infinity, y: Infinity, z: Infinity },
        maxP: { x: -Infinity, y: -Infinity, z: -Infinity }
    }
    undoByPlayer.set(player.name, rec)
    return rec
}

function recordBlock(rec, x, y, z) {
    const key = x + "," + y + "," + z
    if (rec.entries.has(key)) return
    let blk
    try { blk = rec.dimension.getBlock({ x, y, z }) } catch (e) { return }
    if (!blk) return
    try {
        rec.entries.set(key, { x, y, z, perm: blk.permutation })
        rec.minP.x = Math.min(rec.minP.x, x); rec.minP.y = Math.min(rec.minP.y, y); rec.minP.z = Math.min(rec.minP.z, z)
        rec.maxP.x = Math.max(rec.maxP.x, x); rec.maxP.y = Math.max(rec.maxP.y, y); rec.maxP.z = Math.max(rec.maxP.z, z)
    } catch (e) { }
}

// tickingarea はプレイヤーごとに固定名にして、張る前に必ず消す(使い捨て名だと失敗時に残り続けて上限を食う)
function areaNameFor(player) {
    return "wp_" + player.name.replace(/[^A-Za-z0-9_]/g, "_")
}

function setupArea(dimension, player, minP, maxP, yMin, yMax) {
    const name = areaNameFor(player)
    try { dimension.runCommand(`tickingarea remove ${name}`) } catch (e) { }
    try {
        dimension.runCommand(`tickingarea add ${minP.x} ${Math.max(minP.y, yMin)} ${minP.z} ${maxP.x} ${Math.min(maxP.y, yMax - 1)} ${maxP.z} ${name}`)
        return name
    } catch (e) {
        return null
    }
}

function clearArea(dimension, name) {
    if (!name) return
    try { dimension.runCommand(`tickingarea remove ${name}`) } catch (e) { }
}

world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
    const { itemStack, block, player } = event
    if (!itemStack || !block || !player) return
    // 押しっぱなしで連続発火するイベントは無視(多重印刷・多重消費の防止)。
    // 対象のアイテム操作だけは、バニラ動作(ブロック設置など)が走らないようキャンセルだけしておく
    const repeated = event.isFirstEvent === false

    // --- 対応表: 本を羊毛・コンクリートに使う ---
    if (itemStack.typeId === "minecraft:book" && isPattern(block.typeId)) {
        event.cancel = true
        if (repeated) return
        system.run(() => {
            try { sendPalette(player) } catch (e) { console.warn(`[WoolPrinter] palette failed: ${e}`) }
        })
        return
    }

    // --- アンドゥ: ブラシをどれかのブロックに使う ---
    // ただし怪しげな砂・砂利はバニラの発掘が本来の使い方なので横取りしない。
    // 印刷記録が無いときもイベントはキャンセルせず、メッセージだけ出す(バニラ動作を妨げない)
    if (itemStack.typeId === "minecraft:brush") {
        if (block.typeId === "minecraft:suspicious_sand" || block.typeId === "minecraft:suspicious_gravel") return
        if (repeated) return
        const rec = undoByPlayer.get(player.name)
        if (!rec || rec.entries.size === 0) {
            system.run(() => {
                try { msg(player, "woolprinter.msg.undo_none") } catch (e) { }
            })
            return
        }
        event.cancel = true
        system.run(() => {
            try { startUndo(player) } catch (e) { console.warn(`[WoolPrinter] undo failed: ${e}`) }
        })
        return
    }

    const isCore = block.typeId in CORE_LENGTH
    if (!isCore) return

    // --- 球モード: 通常のイカスミ ---
    if (itemStack.typeId === "minecraft:ink_sac") {
        const d = PRINT_DIRECTION[event.blockFace]
        if (!d) return
        event.cancel = true
        if (repeated) return
        const dimension = player.dimension
        const core = { x: block.location.x, y: block.location.y, z: block.location.z }
        const hemisphere = !!player.isSneaking
        system.run(() => {
            try {
                if (startSphere(dimension, core, d, hemisphere, player)) consumeItem(player, "minecraft:ink_sac")
            } catch (e) {
                console.warn(`[WoolPrinter] sphere failed: ${e}`)
            }
        })
        return
    }

    // --- 押し出しモード: 蛍光イカスミ ---
    if (itemStack.typeId !== "minecraft:glow_ink_sac") return
    const length = CORE_LENGTH[block.typeId]
    if (!length) return

    event.cancel = true
    if (repeated) return
    const d = PRINT_DIRECTION[event.blockFace]
    if (!d) return
    const dimension = player.dimension
    const core = { x: block.location.x, y: block.location.y, z: block.location.z }

    system.run(() => {
        try {
            if (startPrint(dimension, core, d, length, player)) consumeItem(player, "minecraft:glow_ink_sac")
        } catch (e) {
            console.warn(`[WoolPrinter] failed: ${e}`)
        }
    })
})

// ============================================================
//  対応表の表示: ブロック名はバニラの言語キーで引くので日英自動
//  注意: Bedrockの名前キーはブロックIDと一致しないものがある(検証済み)
//   - 羊毛/コンクリートは tile.wool.<色>.name / tile.concrete.<色>.name (色名は旧式: 薄灰=silver, 水色=lightBlue)
//   - シーランタン tile.seaLantern.name / 石レンガ tile.stonebrick.default.name / プリズマリンレンガ tile.prismarine.bricks.name
// ============================================================
const LEGACY_COLOR = {
    white: "white", orange: "orange", magenta: "magenta", light_blue: "lightBlue",
    yellow: "yellow", lime: "lime", pink: "pink", gray: "gray", light_gray: "silver",
    cyan: "cyan", purple: "purple", blue: "blue", brown: "brown", green: "green",
    red: "red", black: "black"
}
const NAME_KEY_OVERRIDE = {
    "minecraft:sea_lantern": "tile.seaLantern.name",
    "minecraft:stone_bricks": "tile.stonebrick.default.name",
    "minecraft:prismarine_bricks": "tile.prismarine.bricks.name"
}
function nameKeyOf(id) {
    if (NAME_KEY_OVERRIDE[id]) return NAME_KEY_OVERRIDE[id]
    const bare = id.replace("minecraft:", "")
    const wool = /^(.+)_wool$/.exec(bare)
    if (wool && LEGACY_COLOR[wool[1]]) return "tile.wool." + LEGACY_COLOR[wool[1]] + ".name"
    const conc = /^(.+)_concrete$/.exec(bare)
    if (conc && LEGACY_COLOR[conc[1]]) return "tile.concrete." + LEGACY_COLOR[conc[1]] + ".name"
    return "tile." + bare + ".name"
}

function sendPalette(player) {
    const parts = [{ translate: "woolprinter.palette.title" }, { text: "\n" }]
    for (const [src, dst] of Object.entries(COLOR_TO_BLOCK)) {
        parts.push({ translate: nameKeyOf(src) })
        parts.push({ text: " -> " })
        if (dst === "minecraft:air") parts.push({ translate: "woolprinter.palette.air" })
        else parts.push({ translate: nameKeyOf(dst) })
        parts.push({ text: "\n" })
    }
    parts.push({ translate: "woolprinter.palette.note_core" })
    try { player.sendMessage({ rawtext: parts }) } catch (e) { }
}

function consumeItem(player, typeId) {
    // GameMode の値は版で大文字小文字が違うので、小文字にそろえて比較する(取得に失敗したら安全側=消費しない)
    let creative = true
    try {
        creative = String(player.getGameMode()).toLowerCase() === "creative"
    } catch (e) { creative = true }
    if (creative) return
    const container = player.getComponent("minecraft:inventory").container
    const slot = player.selectedSlotIndex ?? player.selectedSlot
    const item = container.getItem(slot)
    if (!item || item.typeId !== typeId) return
    if (item.amount <= 1) container.setItem(slot, undefined)
    else { item.amount -= 1; container.setItem(slot, item) }
}

// ============================================================
//  アンドゥ実行
// ============================================================
function startUndo(player) {
    const rec = undoByPlayer.get(player.name)
    if (!rec || rec.entries.size === 0) {
        msg(player, "woolprinter.msg.undo_none")
        return
    }
    undoByPlayer.delete(player.name)
    const dimension = rec.dimension
    const list = [...rec.entries.values()]

    let yMin = -64, yMax = 320
    try { yMin = dimension.heightRange.min; yMax = dimension.heightRange.max } catch (e) { }
    const area = setupArea(dimension, player, rec.minP, rec.maxP, yMin, yMax)

    system.runTimeout(() => {
        let idx = 0
        const runId = system.runInterval(() => {
            const end = Math.min(idx + UNDO_BLOCKS_PER_TICK, list.length)
            for (; idx < end; idx++) {
                const e = list[idx]
                try {
                    const blk = dimension.getBlock({ x: e.x, y: e.y, z: e.z })
                    if (blk) blk.setPermutation(e.perm)
                } catch (err) { }
            }
            if (idx >= list.length) {
                system.clearRun(runId)
                clearArea(dimension, area)
                msg(player, "woolprinter.msg.undo_done")
            }
        }, 1)
    }, area ? 20 : 1)
}

// ============================================================
//  押し出しモード
// ============================================================
function startPrint(dimension, core, d, length, player) {
    // 断面を作る2軸
    const { a, b } = planeAxes(d)

    const at = (i, j) => ({
        x: core.x + a.x * i + b.x * j,
        y: core.y + a.y * i + b.y * j,
        z: core.z + a.z * i + b.z * j
    })
    // 核から羊毛が続く限り端まで調べる
    const reach = (di, dj) => {
        let n = 0
        for (let k = 1; k <= MAX_RADIUS; k++) {
            const blk = dimension.getBlock(at(di * k, dj * k))
            if (!blk || !isPattern(blk.typeId)) break
            n = k
        }
        return n
    }
    const aPlus = reach(1, 0), aMinus = reach(-1, 0), bPlus = reach(0, 1), bMinus = reach(0, -1)

    // 断面の各マスを読み取る
    const cells = []
    for (let i = -aMinus; i <= aPlus; i++) {
        for (let j = -bMinus; j <= bPlus; j++) {
            const pos = at(i, j)
            const blk = dimension.getBlock(pos)
            if (!blk || !isPattern(blk.typeId)) continue
            const id = COLOR_TO_BLOCK[blk.typeId] ?? UNMAPPED_BLOCK
            cells.push({ pos, id })
        }
    }
    if (cells.length === 0) {
        msg(player, "woolprinter.msg.no_pattern")
        return false
    }

    let yMin = -64, yMax = 320
    try { yMin = dimension.heightRange.min; yMax = dimension.heightRange.max } catch (e) { }

    // 範囲をチャンクごと読み込んでおく
    let minP = { x: Infinity, y: Infinity, z: Infinity }, maxP = { x: -Infinity, y: -Infinity, z: -Infinity }
    for (const c of cells) {
        for (const s of [0, length]) {
            const p = { x: c.pos.x + d.x * s, y: c.pos.y + d.y * s, z: c.pos.z + d.z * s }
            minP = { x: Math.min(minP.x, p.x), y: Math.min(minP.y, p.y), z: Math.min(minP.z, p.z) }
            maxP = { x: Math.max(maxP.x, p.x), y: Math.max(maxP.y, p.y), z: Math.max(maxP.z, p.z) }
        }
    }
    const area = setupArea(dimension, player, minP, maxP, yMin, yMax)
    if (!area) msg(player, "woolprinter.msg.area_warn")

    // アンドゥ用に、この印刷で変わる範囲の元ブロックを fill の前に記録する
    const rec = newUndoRecord(player, dimension)

    dimension.playSound("random.click", core)

    system.runTimeout(() => {
        let step = 1
        let errors = 0
        const id = system.runInterval(() => {
            const end = Math.min(step + SLICES_PER_TICK - 1, length)
            for (const c of cells) {
                let y1 = c.pos.y + d.y * step, y2 = c.pos.y + d.y * end
                if (Math.max(y1, y2) < yMin || Math.min(y1, y2) >= yMax) continue
                y1 = Math.min(Math.max(y1, yMin), yMax - 1)
                y2 = Math.min(Math.max(y2, yMin), yMax - 1)
                // fill する前に元ブロックを記録
                for (let s = step; s <= end; s++) {
                    recordBlock(rec, c.pos.x + d.x * s, c.pos.y + d.y * s, c.pos.z + d.z * s)
                }
                try {
                    dimension.runCommand(`fill ${c.pos.x + d.x * step} ${y1} ${c.pos.z + d.z * step} ${c.pos.x + d.x * end} ${y2} ${c.pos.z + d.z * end} ${c.id}`)
                } catch (e) { errors++ }
            }
            step = end + 1
            if (step > length) {
                system.clearRun(id)
                clearArea(dimension, area)
                if (errors > 0) msg(player, "woolprinter.msg.print_done_errors", [String(errors)])
                else msg(player, "woolprinter.msg.print_done")
            }
        }, 1)
    }, area ? 20 : 1)
    return true
}

// ============================================================
//  球モード
//  型紙の正方形に内接する球を、中心からの距離の数式だけで描画する
//  (テンプレートリストは持たない)
//  - 通常: 核が球の中心。型紙の面(=赤道面)も材料に変換して両側へ発展
//  - スニーク時: 核が頂点。球の中心は核から印刷方向へ R の位置で、片側だけの半球
//  半径 R は型紙の reach の最小値 + 0.5 (直径21なら reach 10 -> R 10.5)
//  印刷後に型紙は消す(記録してあるのでブラシで戻せる)
// ============================================================
function startSphere(dimension, core, d, hemisphere, player) {
    const { a, b } = planeAxes(d)

    const at = (i, j) => ({
        x: core.x + a.x * i + b.x * j,
        y: core.y + a.y * i + b.y * j,
        z: core.z + a.z * i + b.z * j
    })
    const reach = (di, dj) => {
        let n = 0
        for (let k = 1; k <= MAX_RADIUS; k++) {
            const blk = dimension.getBlock(at(di * k, dj * k))
            if (!blk || !isPattern(blk.typeId)) break
            n = k
        }
        return n
    }
    const aPlus = reach(1, 0), aMinus = reach(-1, 0), bPlus = reach(0, 1), bMinus = reach(0, -1)
    const reachMin = Math.min(aPlus, aMinus, bPlus, bMinus)
    if (reachMin < 1) {
        msg(player, "woolprinter.msg.too_small")
        return false
    }
    const R = reachMin + 0.5
    const R2 = R * R
    const inner2 = SHELL_THICKNESS > 0 ? (R - SHELL_THICKNESS) * (R - SHELL_THICKNESS) : -1

    // 型紙の材料表 (i,j) -> ブロックID と、型紙セルの絶対座標一覧
    const mat = new Map()
    const templateCells = []
    for (let i = -aMinus; i <= aPlus; i++) {
        for (let j = -bMinus; j <= bPlus; j++) {
            const pos = at(i, j)
            const blk = dimension.getBlock(pos)
            if (!blk || !isPattern(blk.typeId)) continue
            mat.set(i + "," + j, COLOR_TO_BLOCK[blk.typeId] ?? UNMAPPED_BLOCK)
            templateCells.push(pos)
        }
    }
    if (mat.size === 0) {
        msg(player, "woolprinter.msg.no_pattern")
        return false
    }

    // 球モードだけの特例: 核のマスは空気にせず、型紙の中で一番多いブロック(空気を除く)に置き換える
    // 例: 白羊毛(→ガラス)の型紙 + 桃の核 でガラス球を作ると、中心もガラスになる
    {
        const counts = new Map()
        for (const [k, v] of mat) {
            if (k === "0,0" || v === "minecraft:air") continue
            counts.set(v, (counts.get(v) ?? 0) + 1)
        }
        let best = null, bestN = 0
        for (const [v, n] of counts) {
            if (n > bestN) { best = v; bestN = n }
        }
        if (best !== null) mat.set("0,0", best)
    }

    let yMin = -64, yMax = 320
    try { yMin = dimension.heightRange.min; yMax = dimension.heightRange.max } catch (e) { }

    // 印刷する全ブロックを先に列挙する: {x,y,z,id}
    // 層: { off: 型紙の面からの距離, dz: 球の中心からの軸方向距離 }
    const layers = []
    if (hemisphere) {
        for (let s = 0; s <= reachMin; s++) layers.push({ off: s, dz: R - s })
    } else {
        for (let t = -reachMin; t <= reachMin; t++) layers.push({ off: t, dz: Math.abs(t) })
    }
    const targets = []
    for (const { off, dz } of layers) {
        const rest = R2 - dz * dz
        if (rest < 0) continue
        const jMax = Math.floor(Math.sqrt(rest))
        for (let j = -jMax; j <= jMax; j++) {
            const iMax = Math.floor(Math.sqrt(rest - j * j))
            for (let i = -iMax; i <= iMax; i++) {
                const dist2 = i * i + j * j + dz * dz
                if (dist2 > R2 || dist2 <= inner2) continue
                const idStr = mat.get(i + "," + j)
                if (idStr === undefined) continue
                targets.push({
                    x: core.x + a.x * i + b.x * j + d.x * off,
                    y: core.y + a.y * i + b.y * j + d.y * off,
                    z: core.z + a.z * i + b.z * j + d.z * off,
                    id: idStr
                })
            }
        }
    }

    // 読み込み範囲: 核 ± (reach+1) の立方体
    const m = reachMin + 1
    const area = setupArea(dimension, player,
        { x: core.x - m, y: core.y - m, z: core.z - m },
        { x: core.x + m, y: core.y + m, z: core.z + m }, yMin, yMax)
    if (!area) msg(player, "woolprinter.msg.area_warn")

    const rec = newUndoRecord(player, dimension)

    dimension.playSound("random.click", core)
    msg(player,
        hemisphere ? "woolprinter.msg.hemisphere_start" : "woolprinter.msg.sphere_start",
        [String(reachMin * 2 + 1)])

    // ブロックID -> Permutation のキャッシュ
    const permCache = new Map()
    const permOf = (idStr) => {
        let p = permCache.get(idStr)
        if (!p) { p = BlockPermutation.resolve(idStr); permCache.set(idStr, p) }
        return p
    }

    system.runTimeout(() => {
        let idx = 0
        let errors = 0
        let templateCleared = false
        const runId = system.runInterval(() => {
            // 層ごとに例外を隔離する: 1層で何か起きても残りの層は止めない
            const end = Math.min(idx + BLOCKS_PER_TICK, targets.length)
            for (; idx < end; idx++) {
                const t = targets[idx]
                if (t.y < yMin || t.y >= yMax) continue
                try {
                    const blk = dimension.getBlock({ x: t.x, y: t.y, z: t.z })
                    if (!blk) { errors++; continue }
                    recordBlock(rec, t.x, t.y, t.z)
                    blk.setPermutation(permOf(t.id))
                } catch (e) { errors++ }
            }
            if (idx >= targets.length) {
                // 印刷が終わったら型紙を消す(元ブロックは記録済みなのでアンドゥで戻る)
                if (!templateCleared) {
                    templateCleared = true
                    for (const pos of templateCells) {
                        try {
                            const blk = dimension.getBlock(pos)
                            if (!blk || !isPattern(blk.typeId)) continue
                            recordBlock(rec, pos.x, pos.y, pos.z)
                            blk.setPermutation(permOf("minecraft:air"))
                        } catch (e) { }
                    }
                }
                system.clearRun(runId)
                clearArea(dimension, area)
                if (errors > 0) msg(player, "woolprinter.msg.print_done_errors", [String(errors)])
                else msg(player, "woolprinter.msg.print_done")
            }
        }, 1)
    }, area ? 20 : 1)
    return true
}
