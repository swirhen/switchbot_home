import type { LucideIcon } from 'lucide-react'
import {
	Activity, AirVent, AlarmClock, Armchair, ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpToLine, Baby, Bath, Battery, BatteryCharging,
	Bed, BedDouble, BedSingle, Bell, BellOff, BellRing, Bike, Blinds, BookOpen, Bot, Briefcase, Cable, Calendar, Camera, Car, Cat, Cctv,
	Check, ChevronDown, ChevronUp, Circle, CircleDot, Clock, Cloud, CloudRain, Coffee, CookingPot, Dog, DoorClosed, DoorClosedLocked, DoorOpen,
	Droplet, Droplets, Eye, EyeOff, Fan, Fence, Film, Flag, Flame, Flower2, Footprints, Gamepad2, Gauge, Hand, Headphones, Heart, Heater, House,
	KeyRound, Lamp, LampCeiling, LampDesk, LampFloor, LampWallUp, Laptop, Leaf, Lightbulb, LightbulbOff, Lock, LockKeyhole, LockKeyholeOpen,
	LockOpen, LogIn, LogOut, Mic, Microwave, Minus, Monitor, Moon, MoonStar, Music, PanelTop, Pause, PersonStanding, Play, Plug, PlugZap,
	Plus, Popcorn, Power, PowerOff, Printer, Projector, Radio, Refrigerator, Rocket, Router, Shirt, ShieldCheck, ShieldOff, ShowerHead, Siren,
	Smartphone, Snowflake, Sofa, Sparkle, Sparkles, Speaker, Sprout, Square, Star, Sun, SunDim, SunMedium, Sunrise, Sunset, Target, Thermometer,
	ThermometerSnowflake, ThermometerSun, Timer, Toilet, Trees, Tv, TvMinimal, Umbrella, Users, Utensils, UtensilsCrossed, Volume2, VolumeX,
	Warehouse, WashingMachine, Waves, Wifi, WifiOff, Wind, Wine, X, Zap, ZapOff,
} from 'lucide-react'
import type { Device } from './common'

export type IconDef = { key: string; label: string; Icon: LucideIcon }

// レイアウトのボタンで選べるアイコン。key はレイアウトに保存するので変えない（並びと表示名は変えてよい）
export const ICON_GROUPS: { label: string; icons: IconDef[] }[] = [
	{
		label: '基本',
		icons: [
			{ key: 'play', label: '再生・実行', Icon: Play },
			{ key: 'pause', label: '一時停止', Icon: Pause },
			{ key: 'stop', label: '停止', Icon: Square },
			{ key: 'power', label: '電源', Icon: Power },
			{ key: 'power-off', label: '電源オフ', Icon: PowerOff },
			{ key: 'zap', label: 'オン', Icon: Zap },
			{ key: 'zap-off', label: 'オフ', Icon: ZapOff },
			{ key: 'check', label: 'チェック', Icon: Check },
			{ key: 'x', label: 'バツ', Icon: X },
			{ key: 'plus', label: 'プラス', Icon: Plus },
			{ key: 'minus', label: 'マイナス', Icon: Minus },
			{ key: 'chevron-up', label: '上', Icon: ChevronUp },
			{ key: 'chevron-down', label: '下', Icon: ChevronDown },
			{ key: 'arrow-up', label: '上矢印', Icon: ArrowUp },
			{ key: 'arrow-down', label: '下矢印', Icon: ArrowDown },
			{ key: 'circle', label: '丸', Icon: Circle },
			{ key: 'circle-dot', label: '二重丸', Icon: CircleDot },
			{ key: 'star', label: '星', Icon: Star },
			{ key: 'heart', label: 'ハート', Icon: Heart },
			{ key: 'sparkles', label: 'きらきら', Icon: Sparkles },
			{ key: 'sparkle', label: 'きらり', Icon: Sparkle },
			{ key: 'flag', label: '旗', Icon: Flag },
			{ key: 'target', label: '的', Icon: Target },
			{ key: 'rocket', label: 'ロケット', Icon: Rocket },
		],
	},
	{
		label: '照明',
		icons: [
			{ key: 'lightbulb', label: '電球（点灯）', Icon: Lightbulb },
			{ key: 'lightbulb-off', label: '電球（消灯）', Icon: LightbulbOff },
			{ key: 'lamp-ceiling', label: 'シーリングライト', Icon: LampCeiling },
			{ key: 'lamp', label: 'ランプ', Icon: Lamp },
			{ key: 'lamp-desk', label: 'デスクライト', Icon: LampDesk },
			{ key: 'lamp-floor', label: 'フロアライト', Icon: LampFloor },
			{ key: 'lamp-wall-up', label: '壁掛けライト', Icon: LampWallUp },
			{ key: 'sun', label: '明るく', Icon: Sun },
			{ key: 'sun-medium', label: 'ふつう', Icon: SunMedium },
			{ key: 'sun-dim', label: '暗く', Icon: SunDim },
			{ key: 'moon', label: '夜・常夜灯', Icon: Moon },
			{ key: 'moon-star', label: 'おやすみ', Icon: MoonStar },
		],
	},
	{
		label: '空調',
		icons: [
			{ key: 'snowflake', label: '冷房', Icon: Snowflake },
			{ key: 'flame', label: '暖房', Icon: Flame },
			{ key: 'droplets', label: '除湿', Icon: Droplets },
			{ key: 'wind', label: '送風', Icon: Wind },
			{ key: 'air-vent', label: 'エアコン', Icon: AirVent },
			{ key: 'fan', label: '扇風機', Icon: Fan },
			{ key: 'heater', label: 'ヒーター', Icon: Heater },
			{ key: 'droplet', label: '加湿', Icon: Droplet },
			{ key: 'waves', label: '空気清浄', Icon: Waves },
			{ key: 'thermometer', label: '温度', Icon: Thermometer },
			{ key: 'thermometer-snowflake', label: '温度を下げる', Icon: ThermometerSnowflake },
			{ key: 'thermometer-sun', label: '温度を上げる', Icon: ThermometerSun },
			{ key: 'gauge', label: 'メーター', Icon: Gauge },
		],
	},
	{
		label: '鍵・ドア・防犯',
		icons: [
			{ key: 'lock', label: '施錠', Icon: Lock },
			{ key: 'lock-open', label: '解錠', Icon: LockOpen },
			{ key: 'lock-keyhole', label: '施錠（鍵穴）', Icon: LockKeyhole },
			{ key: 'lock-keyhole-open', label: '解錠（鍵穴）', Icon: LockKeyholeOpen },
			{ key: 'key-round', label: '鍵', Icon: KeyRound },
			{ key: 'door-closed', label: 'ドア（閉）', Icon: DoorClosed },
			{ key: 'door-open', label: 'ドア（開）', Icon: DoorOpen },
			{ key: 'door-closed-locked', label: 'ドア（施錠）', Icon: DoorClosedLocked },
			{ key: 'shield-check', label: '警戒オン', Icon: ShieldCheck },
			{ key: 'shield-off', label: '警戒オフ', Icon: ShieldOff },
			{ key: 'cctv', label: '防犯カメラ', Icon: Cctv },
			{ key: 'camera', label: 'カメラ', Icon: Camera },
			{ key: 'siren', label: 'サイレン', Icon: Siren },
			{ key: 'bell', label: 'ベル', Icon: Bell },
			{ key: 'bell-ring', label: 'チャイム', Icon: BellRing },
			{ key: 'bell-off', label: '通知オフ', Icon: BellOff },
			{ key: 'eye', label: '見守り', Icon: Eye },
			{ key: 'eye-off', label: '見守りオフ', Icon: EyeOff },
			{ key: 'fence', label: 'フェンス・門', Icon: Fence },
		],
	},
	{
		label: 'カーテン・窓',
		icons: [
			{ key: 'blinds', label: 'ブラインド', Icon: Blinds },
			{ key: 'panel-top', label: '窓', Icon: PanelTop },
			{ key: 'arrow-up-to-line', label: '開ける（上げる）', Icon: ArrowUpToLine },
			{ key: 'arrow-down-to-line', label: '閉める（下げる）', Icon: ArrowDownToLine },
			{ key: 'sunrise', label: '朝・開ける', Icon: Sunrise },
			{ key: 'sunset', label: '夕方・閉める', Icon: Sunset },
		],
	},
	{
		label: '家電・AV',
		icons: [
			{ key: 'tv', label: 'テレビ', Icon: Tv },
			{ key: 'tv-minimal', label: 'モニター（薄型）', Icon: TvMinimal },
			{ key: 'monitor', label: 'モニター', Icon: Monitor },
			{ key: 'projector', label: 'プロジェクター', Icon: Projector },
			{ key: 'film', label: '映画', Icon: Film },
			{ key: 'popcorn', label: 'シアター', Icon: Popcorn },
			{ key: 'speaker', label: 'スピーカー', Icon: Speaker },
			{ key: 'volume-2', label: '音量', Icon: Volume2 },
			{ key: 'volume-x', label: '消音', Icon: VolumeX },
			{ key: 'music', label: '音楽', Icon: Music },
			{ key: 'headphones', label: 'ヘッドホン', Icon: Headphones },
			{ key: 'radio', label: 'ラジオ', Icon: Radio },
			{ key: 'mic', label: 'マイク', Icon: Mic },
			{ key: 'gamepad-2', label: 'ゲーム', Icon: Gamepad2 },
			{ key: 'laptop', label: 'パソコン', Icon: Laptop },
			{ key: 'smartphone', label: 'スマホ', Icon: Smartphone },
			{ key: 'printer', label: 'プリンター', Icon: Printer },
			{ key: 'router', label: 'ルーター', Icon: Router },
			{ key: 'wifi', label: 'Wi-Fi', Icon: Wifi },
			{ key: 'wifi-off', label: 'Wi-Fi オフ', Icon: WifiOff },
			{ key: 'plug', label: 'プラグ', Icon: Plug },
			{ key: 'plug-zap', label: 'プラグ（通電）', Icon: PlugZap },
			{ key: 'cable', label: 'ケーブル', Icon: Cable },
			{ key: 'battery', label: '電池', Icon: Battery },
			{ key: 'battery-charging', label: '充電', Icon: BatteryCharging },
			{ key: 'bot', label: 'ボット', Icon: Bot },
			{ key: 'hand', label: '押す', Icon: Hand },
			{ key: 'refrigerator', label: '冷蔵庫', Icon: Refrigerator },
			{ key: 'washing-machine', label: '洗濯機', Icon: WashingMachine },
			{ key: 'microwave', label: '電子レンジ', Icon: Microwave },
			{ key: 'cooking-pot', label: '調理', Icon: CookingPot },
			{ key: 'coffee', label: 'コーヒー', Icon: Coffee },
		],
	},
	{
		label: '部屋・生活',
		icons: [
			{ key: 'house', label: '家', Icon: House },
			{ key: 'log-in', label: '帰宅', Icon: LogIn },
			{ key: 'log-out', label: '外出', Icon: LogOut },
			{ key: 'bed', label: 'ベッド', Icon: Bed },
			{ key: 'bed-double', label: '寝室', Icon: BedDouble },
			{ key: 'bed-single', label: '子ども部屋', Icon: BedSingle },
			{ key: 'sofa', label: 'リビング', Icon: Sofa },
			{ key: 'armchair', label: 'くつろぐ', Icon: Armchair },
			{ key: 'utensils', label: '食事', Icon: Utensils },
			{ key: 'utensils-crossed', label: 'ダイニング', Icon: UtensilsCrossed },
			{ key: 'wine', label: 'ディナー', Icon: Wine },
			{ key: 'bath', label: 'お風呂', Icon: Bath },
			{ key: 'shower-head', label: 'シャワー', Icon: ShowerHead },
			{ key: 'toilet', label: 'トイレ', Icon: Toilet },
			{ key: 'shirt', label: '衣類・身支度', Icon: Shirt },
			{ key: 'book-open', label: '読書', Icon: BookOpen },
			{ key: 'briefcase', label: '仕事', Icon: Briefcase },
			{ key: 'warehouse', label: '倉庫・車庫', Icon: Warehouse },
			{ key: 'car', label: '車', Icon: Car },
			{ key: 'bike', label: '自転車', Icon: Bike },
			{ key: 'footprints', label: '散歩', Icon: Footprints },
			{ key: 'person-standing', label: '人', Icon: PersonStanding },
			{ key: 'users', label: '家族', Icon: Users },
			{ key: 'baby', label: '赤ちゃん', Icon: Baby },
			{ key: 'dog', label: '犬', Icon: Dog },
			{ key: 'cat', label: '猫', Icon: Cat },
			{ key: 'activity', label: '運動', Icon: Activity },
		],
	},
	{
		label: '時間・天気・自然',
		icons: [
			{ key: 'clock', label: '時計', Icon: Clock },
			{ key: 'alarm-clock', label: '目覚まし', Icon: AlarmClock },
			{ key: 'timer', label: 'タイマー', Icon: Timer },
			{ key: 'calendar', label: '予定', Icon: Calendar },
			{ key: 'cloud', label: 'くもり', Icon: Cloud },
			{ key: 'cloud-rain', label: '雨', Icon: CloudRain },
			{ key: 'umbrella', label: '傘', Icon: Umbrella },
			{ key: 'leaf', label: '葉', Icon: Leaf },
			{ key: 'sprout', label: '植物・水やり', Icon: Sprout },
			{ key: 'flower-2', label: '花', Icon: Flower2 },
			{ key: 'trees', label: '庭', Icon: Trees },
		],
	},
]

const ICONS = new Map(ICON_GROUPS.flatMap(g => g.icons).map(def => [def.key, def]))

export const findIcon = (key: string | null | undefined) => (key ? ICONS.get(key) : undefined)

// 新しく置く操作ボタンに最初から付けるアイコン（機器の種類と操作から選ぶ）
export function suggestIcon(device: Device, command: string): string | null {
	const t = device.type
	const on = command === 'turnOn'
	if (command === 'lock') return 'lock'
	if (command === 'unlock') return 'lock-open'
	if (command === 'press') return 'hand'
	if (/Curtain|Roller Shade|Blind Tilt/i.test(t)) return on ? 'arrow-up-to-line' : 'arrow-down-to-line'
	if (/Light|Bulb|Strip|Lamp|Ceiling/i.test(t)) return on ? 'lightbulb' : 'lightbulb-off'
	if (/Air Conditioner/i.test(t)) return on ? 'air-vent' : 'power-off'
	if (/TV|Set Top Box|Projector|Streamer/i.test(t)) return on ? 'tv' : 'power-off'
	if (/Speaker/i.test(t)) return on ? 'speaker' : 'power-off'
	if (/Fan/i.test(t)) return on ? 'fan' : 'power-off'
	if (/Humidifier/i.test(t)) return on ? 'droplet' : 'power-off'
	if (/Purifier/i.test(t)) return on ? 'waves' : 'power-off'
	if (/Plug|Relay/i.test(t)) return on ? 'plug-zap' : 'plug'
	if (command === 'turnOn') return 'power'
	if (command === 'turnOff') return 'power-off'
	return null
}
