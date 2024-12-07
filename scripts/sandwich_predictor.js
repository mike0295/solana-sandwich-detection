import sql from "../db.js";
import { Connection } from "@solana/web3.js";
import 'dotenv/config';
import WebSocket from 'ws';

const solana = new Connection(process.env.SOLANA_RPC_URL);
const PUBLISH_INTERVAL = 2500;
const FUTURE_SLOTS_COUNT = 25;

async function fetch_validator_sandwich_probability() {
    // fetch validator sandwich probability for all leaders
    const data = await sql`
        WITH validator_block_counts AS (
        SELECT
            validator,
            COUNT(slot_number) AS total_blocks
        FROM
            validator
        WHERE
            validator IS NOT NULL
        GROUP BY
            validator
        ),
        validator_sandwich_counts AS (
            SELECT
                validator,
                COUNT(DISTINCT slot_number) AS sandwich_blocks
            FROM
                sandwich_with_leaders
            WHERE
                validator IS NOT NULL
            GROUP BY
                validator
        )
        SELECT
            vbc.validator,
            COALESCE(vsc.sandwich_blocks, 0) AS sandwich_blocks,
            vbc.total_blocks,
            COALESCE(vsc.sandwich_blocks, 0) * 1.0 / vbc.total_blocks AS proportion
        FROM
            validator_block_counts vbc
        LEFT JOIN
            validator_sandwich_counts vsc
        ON
            vbc.validator = vsc.validator
        ORDER BY
            proportion DESC;`

    const result = {};
    for (const row of data) {
        result[row.validator] = Number(row.proportion);
    }
    return result;
}

async function fetch_future_slots_and_leaders() {
    const current_epoch = await solana.getEpochInfo();
    const first_slot_in_epoch = current_epoch.absoluteSlot - current_epoch.slotIndex;
    const current_slot = current_epoch.absoluteSlot;
    console.log("Epoch slot range:", first_slot_in_epoch, current_slot);

    // fetch future slots and leaders for current epoch
    const leader_schedule = await solana.getLeaderSchedule(); // leader -> array of slot numbers
    const future_slots_and_leaders = {}; // slot number -> leader
    for (const leader in leader_schedule) {
        for (const slot_index of leader_schedule[leader]) {
            const slot_number = slot_index + first_slot_in_epoch;
            if (slot_number >= current_slot) {
                future_slots_and_leaders[slot_number] = leader;
            }
        }
    }
    return future_slots_and_leaders;
}

function calculate_average_sandwich_probability(sandwich_probability_for_future_slots, start_slot, end_slot) {
    let sum = 0;
    let count = 0;
    for (let slot_number = start_slot; slot_number <= end_slot; slot_number++) {
        if (sandwich_probability_for_future_slots[slot_number] !== null) {
            sum += sandwich_probability_for_future_slots[slot_number];
            count++;
        }
    }
    return sum / count;
}

function start_websocket_server(max_start_slot, sandwich_probability_for_future_slots) {
    const wss = new WebSocket.Server({ port: 8080 });

    wss.on('connection', function connection(ws) {
        console.log('Client connected');
        
        ws.on('close', () => {
            console.log('Client disconnected');
        });
        
        // send sandwich probability for next FUTURE_SLOTS_COUNT slots every PUBLISH_INTERVAL seconds
        setInterval(async () => {
            const current_slot = await solana.getSlot();
            if (current_slot > max_start_slot) {
                console.log("max start slot reached, closing connection");
                ws.close();
            } else {
                ws.send(JSON.stringify({
                    sandwich_probability: calculate_average_sandwich_probability(sandwich_probability_for_future_slots, current_slot, current_slot + FUTURE_SLOTS_COUNT)
                }));
            }
        }, PUBLISH_INTERVAL);
    });

    console.log('WebSocket server started on port 8080');
}

async function run_sandwich_predictor() {
    const validator_sandwich_probability = await fetch_validator_sandwich_probability();
    console.log("fetched validator sandwich probability");

    // sleep for 0.5 seconds
    await new Promise(resolve => setTimeout(resolve, 500));

    // fetch future slots and leaders for current epoch
    const future_slots_and_leaders = await fetch_future_slots_and_leaders();
    console.log("fetched future slots and leaders");
    
    // calculate sandwich probability for each slot
    const sandwich_probability_for_future_slots = {};
    let no_data_leader = {};
    for (const slot_number in future_slots_and_leaders) {
        const leader = future_slots_and_leaders[slot_number];
        if (validator_sandwich_probability[leader]) {
            sandwich_probability_for_future_slots[slot_number] = validator_sandwich_probability[leader];
        } else {
            sandwich_probability_for_future_slots[slot_number] = null;
            no_data_leader[leader] = true;
        }
    }
    console.log(`calculated sandwich probability for future slots, ${Object.keys(no_data_leader).length} leaders have no data`);
    
    const max_start_slot = Array.from(new Set(Object.keys(sandwich_probability_for_future_slots))).reduce((a, b) => Math.max(a, b)) - FUTURE_SLOTS_COUNT;
    start_websocket_server(max_start_slot, sandwich_probability_for_future_slots);
}

function main() {
    run_sandwich_predictor();
}

main();