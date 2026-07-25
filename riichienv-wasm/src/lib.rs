use std::cell::RefCell;
use std::collections::HashMap;

use wasm_bindgen::prelude::*;

use riichienv_core::action::{Action, ActionType};
use riichienv_core::hand_evaluator::HandEvaluator;
use riichienv_core::hand_evaluator_3p::HandEvaluator3P;
use riichienv_core::observation_3p::Observation3P;
use riichienv_core::parser::{mjai_to_tid, tid_to_mjai};
use riichienv_core::rule::GameRule;
use riichienv_core::state_3p::legal_actions::GameState3PLegalActions;
use riichienv_core::state_3p::GameState3P;
use riichienv_core::types::{Conditions, Meld, MeldType, WinResult, Wind};
use riichienv_core::{score, yaku};

thread_local! {
    static GAME_STATE: RefCell<Option<GameState3P>> = const { RefCell::new(None) };
}

fn with_state_mut<F, R>(f: F) -> Result<R, JsValue>
where
    F: FnOnce(&mut GameState3P) -> R,
{
    GAME_STATE.with(|cell| {
        let mut borrow = cell.borrow_mut();
        match borrow.as_mut() {
            Some(state) => Ok(f(state)),
            None => Err(JsValue::from_str(
                "No game in progress. Call sanma_new_game() first.",
            )),
        }
    })
}

fn with_state_ref<F, R>(f: F) -> Result<R, JsValue>
where
    F: FnOnce(&GameState3P) -> R,
{
    GAME_STATE.with(|cell| {
        let borrow = cell.borrow();
        match borrow.as_ref() {
            Some(state) => Ok(f(state)),
            None => Err(JsValue::from_str(
                "No game in progress. Call sanma_new_game() first.",
            )),
        }
    })
}

fn parse_mjai_action(mjai_json: &str, player_id: u8) -> Result<Action, JsValue> {
    let v: serde_json::Value = serde_json::from_str(mjai_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse MJAI JSON: {}", e)))?;

    let type_str = v["type"].as_str().unwrap_or("");
    let action_type = match type_str {
        "dahai" => ActionType::Discard,
        "hora" => ActionType::Ron,
        "reach" => ActionType::Riichi,
        "pon" => ActionType::Pon,
        "daiminkan" => ActionType::Daiminkan,
        "ankan" => ActionType::Ankan,
        "kakan" => ActionType::Kakan,
        "ryukyoku" => ActionType::KyushuKyuhai,
        "kita" => ActionType::Kita,
        "none" => ActionType::Pass,
        _ => {
            return Err(JsValue::from_str(&format!(
                "Unknown MJAI action type: {}",
                type_str
            )))
        }
    };

    let tile = v["pai"].as_str().and_then(|s| mjai_to_tid(s));
    let consume_tiles: Vec<u8> = v
        .get("consumed")
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().and_then(|s| mjai_to_tid(s)))
                .collect()
        })
        .unwrap_or_default();

    Ok(Action::new(action_type, tile, consume_tiles, Some(player_id)))
}

fn tile_type(tid: Option<u8>) -> u8 {
    match tid {
        Some(t) => t / 4,
        None => 255,
    }
}

fn is_red(tid: Option<u8>) -> bool {
    match tid {
        Some(t) => t % 4 == 0,
        None => false,
    }
}

fn find_matching_action(legal: &[Action], target: &Action) -> Option<Action> {
    match target.action_type {
        ActionType::Tsumo | ActionType::Ron => legal
            .iter()
            .find(|a| matches!(a.action_type, ActionType::Tsumo | ActionType::Ron))
            .cloned(),
        ActionType::Kita => legal
            .iter()
            .find(|a| a.action_type == ActionType::Kita)
            .cloned(),
        ActionType::Discard | ActionType::Riichi => {
            let exact = legal
                .iter()
                .find(|a| {
                    a.action_type == target.action_type
                        && tile_type(a.tile) == tile_type(target.tile)
                        && is_red(a.tile) == is_red(target.tile)
                })
                .cloned();
            if exact.is_some() {
                exact
            } else {
                legal
                    .iter()
                    .find(|a| {
                        a.action_type == target.action_type
                            && tile_type(a.tile) == tile_type(target.tile)
                    })
                    .cloned()
            }
        }
        _ => legal
            .iter()
            .find(|a| {
                a.action_type == target.action_type
                    && tile_type(a.tile) == tile_type(target.tile)
            })
            .or_else(|| {
                legal
                    .iter()
                    .find(|a| a.action_type == target.action_type)
            })
            .cloned(),
    }
}

#[derive(serde::Serialize)]
struct StepResult {
    active_players: Vec<u8>,
    current_player: u8,
    phase: String,
    is_done: bool,
    last_error: Option<String>,
}

// ---------------------------------------------------------------------------
// Existing score/wait/tile utilities (unchanged)
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
struct MeldInput {
    meld_type: String,
    tiles: Vec<u8>,
}

impl MeldInput {
    fn to_meld(&self) -> Meld {
        let meld_type = match self.meld_type.as_str() {
            "chi" => MeldType::Chi,
            "pon" => MeldType::Pon,
            "daiminkan" => MeldType::Daiminkan,
            "ankan" => MeldType::Ankan,
            "kakan" => MeldType::Kakan,
            _ => MeldType::Chi,
        };
        Meld::new(
            meld_type,
            self.tiles.clone(),
            meld_type != MeldType::Ankan,
            -1,
            None,
        )
    }
}

#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct ConditionsInput {
    tsumo: bool,
    riichi: bool,
    double_riichi: bool,
    ippatsu: bool,
    haitei: bool,
    houtei: bool,
    rinshan: bool,
    chankan: bool,
    tsumo_first_turn: bool,
    player_wind: u8,
    round_wind: u8,
    honba: u32,
    kita_count: u8,
    is_sanma: bool,
    is_kokushi_musou_13machi_double: bool,
    is_suuankou_tanki_double: bool,
    is_junsei_chuurenpoutou_double: bool,
    is_daisuushii_double: bool,
}

impl ConditionsInput {
    fn to_conditions(&self) -> Conditions {
        Conditions {
            tsumo: self.tsumo,
            riichi: self.riichi,
            double_riichi: self.double_riichi,
            ippatsu: self.ippatsu,
            haitei: self.haitei,
            houtei: self.houtei,
            rinshan: self.rinshan,
            chankan: self.chankan,
            tsumo_first_turn: self.tsumo_first_turn,
            player_wind: Wind::from(self.player_wind),
            round_wind: Wind::from(self.round_wind),
            riichi_sticks: 0,
            honba: self.honba,
            kita_count: self.kita_count,
            is_sanma: self.is_sanma,
            num_players: if self.is_sanma { 3 } else { 4 },
        }
    }
}

#[derive(serde::Serialize)]
struct ScoreResult {
    is_win: bool,
    yakuman: bool,
    han: u32,
    fu: u32,
    ron_agari: u32,
    tsumo_agari_oya: u32,
    tsumo_agari_ko: u32,
    yaku: Vec<u32>,
}

fn apply_double_yakuman_rules(score: &mut ScoreResult, conditions: &ConditionsInput) {
    if !score.yakuman || score.han <= 13 {
        return;
    }

    let mut cap = 0u32;
    for &y in &score.yaku {
        match y {
            yaku::ID_JUNSEI_CHUUREN if !conditions.is_junsei_chuurenpoutou_double => cap += 13,
            yaku::ID_SUANKO_TANKI if !conditions.is_suuankou_tanki_double => cap += 13,
            yaku::ID_KOKUSHI_13 if !conditions.is_kokushi_musou_13machi_double => cap += 13,
            yaku::ID_DAISUUSHI if !conditions.is_daisuushii_double => cap += 13,
            _ => {}
        }
    }

    if cap == 0 {
        return;
    }

    score.han = score.han.saturating_sub(cap).max(13);
    let score_res = score::calculate_score(
        score.han as u8,
        0,
        conditions.player_wind % 4 == Wind::East as u8,
        conditions.tsumo,
        conditions.honba,
        if conditions.is_sanma { 3 } else { 4 },
    );
    score.ron_agari = score_res.pay_ron;
    score.tsumo_agari_oya = score_res.pay_tsumo_oya;
    score.tsumo_agari_ko = score_res.pay_tsumo_ko;
}

#[wasm_bindgen]
pub fn calc_waits(tiles_json: &str, melds_json: &str) -> Result<JsValue, JsValue> {
    let tiles: Vec<u8> = serde_json::from_str(tiles_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse tiles: {}", e)))?;

    let meld_inputs: Vec<MeldInput> = serde_json::from_str(melds_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse melds: {}", e)))?;

    let melds: Vec<Meld> = meld_inputs.iter().map(|m| m.to_meld()).collect();

    let evaluator = HandEvaluator::new(tiles, melds);
    let waits = evaluator.get_waits_u8();

    serde_wasm_bindgen::to_value(&waits)
        .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
}

#[wasm_bindgen]
pub fn calc_score(
    tiles_json: &str,
    melds_json: &str,
    win_tile: u8,
    dora_json: &str,
    ura_json: &str,
    conditions_json: &str,
) -> Result<JsValue, JsValue> {
    let tiles: Vec<u8> = serde_json::from_str(tiles_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse tiles: {}", e)))?;

    let meld_inputs: Vec<MeldInput> = serde_json::from_str(melds_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse melds: {}", e)))?;

    let dora_indicators: Vec<u8> = serde_json::from_str(dora_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse dora: {}", e)))?;

    let ura_indicators: Vec<u8> = serde_json::from_str(ura_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse ura: {}", e)))?;

    let cond_input: ConditionsInput = serde_json::from_str(conditions_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse conditions: {}", e)))?;

    let melds: Vec<Meld> = meld_inputs.iter().map(|m| m.to_meld()).collect();
    let conditions = cond_input.to_conditions();

    let result = if cond_input.is_sanma {
        let evaluator = HandEvaluator3P::new(tiles, melds);
        evaluator.calc(win_tile, dora_indicators, ura_indicators, Some(conditions))
    } else {
        let evaluator = HandEvaluator::new(tiles, melds);
        evaluator.calc(win_tile, dora_indicators, ura_indicators, Some(conditions))
    };

    let mut score = ScoreResult {
        is_win: result.is_win,
        yakuman: result.yakuman,
        han: result.han,
        fu: result.fu,
        ron_agari: result.ron_agari,
        tsumo_agari_oya: result.tsumo_agari_oya,
        tsumo_agari_ko: result.tsumo_agari_ko,
        yaku: result.yaku,
    };
    apply_double_yakuman_rules(&mut score, &cond_input);

    serde_wasm_bindgen::to_value(&score)
        .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
}

#[wasm_bindgen]
pub fn mjai_to_tile_id(mjai: &str) -> Option<u8> {
    mjai_to_tid(mjai)
}

#[wasm_bindgen]
pub fn tile_id_to_mjai(tid: u8) -> String {
    tid_to_mjai(tid)
}

// ---------------------------------------------------------------------------
// Sanma State3P game lifecycle bindings
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub fn sanma_new_game(seed: u32, initial_oya: u8) -> Result<JsValue, JsValue> {
    let state = GameState3P::new(
        5,
        false,
        Some(seed as u64),
        0,
        GameRule::default_mjsoul(),
        initial_oya,
    );
    GAME_STATE.with(|cell| {
        *cell.borrow_mut() = Some(state);
    });
    let info = with_state_ref(|s| {
        serde_json::json!({
            "active_players": s.active_players,
            "current_player": s.current_player,
            "phase": format!("{:?}", s.phase),
            "is_done": s.is_done,
            "oya": s.oya,
            "scores": s.players.iter().map(|p| p.score).collect::<Vec<_>>(),
            "dora_indicators": s.wall.dora_indicators,
            "hands": s.players.iter().map(|p| p.hand.iter().map(|&t| t as u32).collect::<Vec<_>>()).collect::<Vec<_>>(),
        })
    })?;
    serde_wasm_bindgen::to_value(&info)
        .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
}

#[wasm_bindgen]
pub fn sanma_legal_actions(player_id: u8) -> Result<JsValue, JsValue> {
    with_state_ref(|state| {
        let actions = state._get_legal_actions_internal(player_id);
        let action_dicts: Vec<serde_json::Value> = actions
            .iter()
            .map(|a| {
                serde_json::json!({
                    "action_type": format!("{:?}", a.action_type),
                    "tile": a.tile,
                    "consume_tiles": a.consume_tiles,
                    "actor": a.actor,
                    "mjai": a.to_mjai(),
                })
            })
            .collect();
        serde_wasm_bindgen::to_value(&action_dicts)
            .unwrap_or_else(|_| JsValue::NULL)
    })
}

#[wasm_bindgen]
pub fn sanma_step(actions_json: &str) -> Result<JsValue, JsValue> {
    let actions: HashMap<u8, Action> = serde_json::from_str(actions_json).map_err(|e| {
        JsValue::from_str(&format!("Failed to parse actions JSON: {}", e))
    })?;

    with_state_mut(|state| {
        state.step(&actions);

        let result = StepResult {
            active_players: state.active_players.clone(),
            current_player: state.current_player,
            phase: format!("{:?}", state.phase),
            is_done: state.is_done,
            last_error: state.last_error.clone(),
        };

        serde_wasm_bindgen::to_value(&result)
            .unwrap_or_else(|_| JsValue::NULL)
    })
}

#[wasm_bindgen]
pub fn sanma_mjai_log() -> Result<JsValue, JsValue> {
    with_state_ref(|state| {
        let log: Vec<serde_json::Value> = state
            .mjai_log
            .iter()
            .filter_map(|s| serde_json::from_str(s).ok())
            .collect();
        serde_wasm_bindgen::to_value(&log).unwrap_or_else(|_| JsValue::NULL)
    })
}

#[wasm_bindgen]
pub fn sanma_is_done() -> Result<JsValue, JsValue> {
    with_state_ref(|state| {
        serde_wasm_bindgen::to_value(&state.is_done).unwrap_or_else(|_| JsValue::NULL)
    })
}

#[wasm_bindgen]
pub fn sanma_scores() -> Result<JsValue, JsValue> {
    with_state_ref(|state| {
        let scores: Vec<i32> = state.players.iter().map(|p| p.score).collect();
        serde_wasm_bindgen::to_value(&scores).unwrap_or_else(|_| JsValue::NULL)
    })
}

#[wasm_bindgen]
pub fn sanma_observation(player_id: u8) -> Result<JsValue, JsValue> {
    with_state_mut(|state| {
        let obs: Observation3P = state.get_observation(player_id);
        serde_wasm_bindgen::to_value(&obs).unwrap_or_else(|_| JsValue::NULL)
    })
}

#[wasm_bindgen]
pub fn sanma_encode(player_id: u8) -> Result<JsValue, JsValue> {
    with_state_mut(|state| {
        let obs: Observation3P = state.get_observation(player_id);
        let encoded = obs.encode_to_vec();
        serde_wasm_bindgen::to_value(&encoded).unwrap_or_else(|_| JsValue::NULL)
    })
}

#[wasm_bindgen]
pub fn sanma_select_action_from_mjai(
    player_id: u8,
    mjai_json: &str,
) -> Result<JsValue, JsValue> {
    let target = parse_mjai_action(mjai_json, player_id)?;

    with_state_ref(|state| {
        let legal = state._get_legal_actions_internal(player_id);
        match find_matching_action(&legal, &target) {
            Some(action) => serde_wasm_bindgen::to_value(&action)
                .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e))),
            None => Err(JsValue::from_str("No matching legal action found")),
        }
    })?
}

#[wasm_bindgen]
pub fn sanma_win_results() -> Result<JsValue, JsValue> {
    with_state_ref(|state| {
        let mut results: HashMap<String, &WinResult> = HashMap::new();
        for (&k, v) in &state.win_results {
            results.insert(k.to_string(), v);
        }
        for (&k, v) in &state.last_win_results {
            results.entry(k.to_string()).or_insert(v);
        }
        serde_wasm_bindgen::to_value(&results).unwrap_or_else(|_| JsValue::NULL)
    })
}

#[wasm_bindgen]
pub fn sanma_hora_detail(actor: u8) -> Result<JsValue, JsValue> {
    with_state_ref(|state| {
        match state.compute_hora_detail(actor) {
            Some(detail) => serde_wasm_bindgen::to_value(&detail)
                .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e))),
            None => Ok(JsValue::NULL),
        }
    })?
}

#[wasm_bindgen]
pub fn sanma_dora_indicators() -> Result<JsValue, JsValue> {
    with_state_ref(|state| {
        let indicators: Vec<u32> = state
            .wall
            .dora_indicators
            .iter()
            .map(|&t| t as u32)
            .collect();
        serde_wasm_bindgen::to_value(&indicators).unwrap_or_else(|_| JsValue::NULL)
    })
}

#[wasm_bindgen]
pub fn sanma_hands() -> Result<JsValue, JsValue> {
    with_state_ref(|state| {
        let hands: Vec<Vec<u32>> = state
            .players
            .iter()
            .map(|p| p.hand.iter().map(|&t| t as u32).collect())
            .collect();
        serde_wasm_bindgen::to_value(&hands).unwrap_or_else(|_| JsValue::NULL)
    })
}

#[wasm_bindgen]
pub fn sanma_melds() -> Result<JsValue, JsValue> {
    with_state_ref(|state| {
        let melds: Vec<Vec<&Meld>> = state
            .players
            .iter()
            .map(|p| p.melds.iter().collect())
            .collect();
        serde_wasm_bindgen::to_value(&melds).unwrap_or_else(|_| JsValue::NULL)
    })
}

#[wasm_bindgen]
pub fn sanma_new_game_with_wall(wall_json: &str, initial_oya: u8) -> Result<JsValue, JsValue> {
    let wall_tiles: Vec<u8> = serde_json::from_str(wall_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid wall JSON: {}", e)))?;
    if wall_tiles.len() != 108 {
        return Err(JsValue::from_str(&format!("Wall must have 108 tiles, got {}", wall_tiles.len())));
    }
    let mut state = GameState3P::new(
        5,
        false,
        Some(0u64),
        0,
        GameRule::default_mjsoul(),
        initial_oya,
    );
    let oya = state.oya;
    let round_wind = state.round_wind;
    let honba = state.honba;
    let riichi_sticks = state.riichi_sticks;
    state._initialize_round(
        oya,
        round_wind,
        honba,
        riichi_sticks,
        Some(wall_tiles),
        None,
    );
    GAME_STATE.with(|cell| {
        *cell.borrow_mut() = Some(state);
    });
    let info = with_state_ref(|s| {
        serde_json::json!({
            "active_players": s.active_players,
            "current_player": s.current_player,
            "phase": format!("{:?}", s.phase),
            "is_done": s.is_done,
            "oya": s.oya,
            "scores": s.players.iter().map(|p| p.score).collect::<Vec<_>>(),
            "dora_indicators": s.wall.dora_indicators,
            "hands": s.players.iter().map(|p| p.hand.iter().map(|&t| t as u32).collect::<Vec<_>>()).collect::<Vec<_>>(),
        })
    })?;
    serde_wasm_bindgen::to_value(&info)
        .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn double_yakuman_score(yaku_id: u32) -> ScoreResult {
        ScoreResult {
            is_win: true,
            yakuman: true,
            han: 26,
            fu: 0,
            ron_agari: 64000,
            tsumo_agari_oya: 32000,
            tsumo_agari_ko: 16000,
            yaku: vec![yaku_id],
        }
    }

    #[test]
    fn tenhou_default_caps_suuankou_tanki_to_single_yakuman() {
        let conditions = ConditionsInput {
            player_wind: Wind::South as u8,
            ..Default::default()
        };
        let mut score = double_yakuman_score(yaku::ID_SUANKO_TANKI);

        apply_double_yakuman_rules(&mut score, &conditions);

        assert_eq!(score.han, 13);
        assert_eq!(score.ron_agari, 32000);
    }

    #[test]
    fn enabled_suuankou_tanki_rule_keeps_double_yakuman() {
        let conditions = ConditionsInput {
            player_wind: Wind::South as u8,
            is_suuankou_tanki_double: true,
            ..Default::default()
        };
        let mut score = double_yakuman_score(yaku::ID_SUANKO_TANKI);

        apply_double_yakuman_rules(&mut score, &conditions);

        assert_eq!(score.han, 26);
        assert_eq!(score.ron_agari, 64000);
    }

    #[test]
    fn sanma_new_game_creates_valid_state() {
        let state = GameState3P::new(5, false, Some(42), 0, GameRule::default_mjsoul(), 0);
        assert!(!state.is_done);
        assert_eq!(state.active_players, vec![0]);
        assert_eq!(state.players.len(), 3);
        assert_eq!(state.wall.dora_indicators.len(), 1);
    }

    #[test]
    fn sanma_legal_actions_for_dealer() {
        let state = GameState3P::new(5, false, Some(42), 0, GameRule::default_mjsoul(), 0);
        let actions = state._get_legal_actions_internal(0);
        assert!(!actions.is_empty());
    }

    #[test]
    fn sanma_step_discard() {
        let mut state = GameState3P::new(5, false, Some(42), 0, GameRule::default_mjsoul(), 0);
        let actions = state._get_legal_actions_internal(0);
        let discard = actions
            .iter()
            .find(|a| a.action_type == ActionType::Discard)
            .expect("should have a discard action");
        let mut map = HashMap::new();
        map.insert(0u8, discard.clone());
        state.step(&map);
        assert!(!state.is_done);
    }

    #[test]
    fn sanma_scores_start_at_35000() {
        let state = GameState3P::new(5, false, Some(42), 0, GameRule::default_mjsoul(), 0);
        for p in &state.players {
            assert_eq!(p.score, 35000);
        }
    }

    #[test]
    fn sanma_hands_have_correct_tile_count() {
        let state = GameState3P::new(5, false, Some(42), 0, GameRule::default_mjsoul(), 0);
        assert_eq!(state.players[state.oya as usize].hand.len(), 14);
        for (i, p) in state.players.iter().enumerate() {
            if i != state.oya as usize {
                assert_eq!(p.hand.len(), 13);
            }
        }
    }

    #[test]
    fn sanma_mjai_log_has_events() {
        let state = GameState3P::new(5, false, Some(42), 0, GameRule::default_mjsoul(), 0);
        assert!(!state.mjai_log.is_empty());
    }

    #[test]
    fn sanma_observation_serializes() {
        let mut state = GameState3P::new(5, false, Some(42), 0, GameRule::default_mjsoul(), 0);
        let obs = state.get_observation(0);
        assert_eq!(obs.player_id, 0);
        let json = serde_json::to_value(&obs).unwrap();
        assert!(json.is_object());
    }

    #[test]
    fn sanma_encode_returns_vector() {
        let mut state = GameState3P::new(5, false, Some(42), 0, GameRule::default_mjsoul(), 0);
        let obs = state.get_observation(0);
        let encoded = obs.encode_to_vec();
        assert_eq!(encoded.len(), 182 * 27);
    }

    fn make_state_for_kita_test() -> GameState3P {
        let mut state = GameState3P::new(5, false, Some(42), 0, GameRule::default_mjsoul(), 0);
        state.wall.drawable_count = 20;
        state
    }

    #[test]
    fn kita_non_riichi_generates_action_per_north_in_hand() {
        let mut state = make_state_for_kita_test();
        let pid = state.current_player;
        state.players[pid as usize].riichi_declared = false;
        state.players[pid as usize].hand = vec![0, 36, 72, 120, 121, 122, 84];
        state.drawn_tile = Some(3);

        let actions = state.get_kita_legal_actions(pid);

        assert_eq!(actions.len(), 3);
        assert!(actions.iter().all(|a| a.action_type == ActionType::Kita));
        let tiles: std::collections::HashSet<u8> =
            actions.iter().map(|a| a.tile.unwrap()).collect();
        assert!(tiles.contains(&120));
        assert!(tiles.contains(&121));
        assert!(tiles.contains(&122));
    }

    #[test]
    fn kita_non_riichi_no_north_in_hand_yields_empty() {
        let mut state = make_state_for_kita_test();
        let pid = state.current_player;
        state.players[pid as usize].riichi_declared = false;
        state.players[pid as usize].hand = vec![0, 4, 36, 40, 72, 76, 84];
        state.drawn_tile = Some(3);

        let actions = state.get_kita_legal_actions(pid);

        assert!(actions.is_empty());
    }

    #[test]
    fn kita_riichi_drawn_north_allows_single_kita() {
        let mut state = make_state_for_kita_test();
        let pid = state.current_player;
        state.players[pid as usize].riichi_declared = true;
        state.players[pid as usize].hand = vec![0, 36, 120, 121, 72, 84, 88];
        state.drawn_tile = Some(122);

        let actions = state.get_kita_legal_actions(pid);

        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].action_type, ActionType::Kita);
        assert_eq!(actions[0].tile, Some(122));
    }

    #[test]
    fn kita_riichi_drawn_not_north_blocks_kita_even_with_north_in_hand() {
        let mut state = make_state_for_kita_test();
        let pid = state.current_player;
        state.players[pid as usize].riichi_declared = true;
        state.players[pid as usize].hand = vec![0, 36, 120, 121, 122, 72, 84];
        state.drawn_tile = Some(3);

        let actions = state.get_kita_legal_actions(pid);

        assert!(actions.is_empty());
    }

    #[test]
    fn kita_riichi_north_pair_in_hand_drawn_other_blocked() {
        let mut state = make_state_for_kita_test();
        let pid = state.current_player;
        state.players[pid as usize].riichi_declared = true;
        state.players[pid as usize].hand = vec![0, 36, 120, 121, 72, 76, 80];
        state.drawn_tile = Some(84);

        let actions = state.get_kita_legal_actions(pid);

        assert!(actions.is_empty());
    }

    #[test]
    fn kita_no_drawn_tile_yields_empty() {
        let mut state = make_state_for_kita_test();
        let pid = state.current_player;
        state.players[pid as usize].riichi_declared = false;
        state.players[pid as usize].hand = vec![0, 120, 121];
        state.drawn_tile = None;

        let actions = state.get_kita_legal_actions(pid);

        assert!(actions.is_empty());
    }

    #[test]
    fn kita_wall_exhausted_yields_empty() {
        let mut state = make_state_for_kita_test();
        let pid = state.current_player;
        state.players[pid as usize].riichi_declared = false;
        state.players[pid as usize].hand = vec![0, 120, 121];
        state.drawn_tile = Some(3);
        state.wall.drawable_count = 0;

        let actions = state.get_kita_legal_actions(pid);

        assert!(actions.is_empty());
    }

    #[test]
    fn kita_riichi_drawn_north_not_in_hand_still_allows() {
        let mut state = make_state_for_kita_test();
        let pid = state.current_player;
        state.players[pid as usize].riichi_declared = true;
        state.players[pid as usize].hand = vec![0, 36, 72, 84, 88, 92, 96];
        state.drawn_tile = Some(120);

        let actions = state.get_kita_legal_actions(pid);

        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].action_type == ActionType::Kita && actions[0].tile == Some(120), true);
    }
}
