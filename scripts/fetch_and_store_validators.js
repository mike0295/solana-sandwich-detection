import sql from "../db.js";
import { Connection } from "@solana/web3.js";
import 'dotenv/config';

async function get_lowest_and_largest_slot() {
    const largest_slot = await sql`
    SELECT 
        MAX(slot_number) AS largest_slot
    FROM 
        sandwich_with_leaders
    WHERE 
        validator IS NULL;`;

    const lowest_slot = await sql`
    SELECT 
        MAX(slot_number) AS lowest_slot
    FROM 
        validator;`;

    return { lowest_slot: lowest_slot[0].lowest_slot, largest_slot: largest_slot[0].largest_slot };
}

async function fetch_and_store_validators() {
    const { lowest_slot, largest_slot } = await get_lowest_and_largest_slot();
    console.log(lowest_slot, largest_slot);
    console.log(largest_slot - lowest_slot);
    
    let currentSlot = Number(lowest_slot);
    const limit = 5000;
    const solana = new Connection(process.env.SOLANA_RPC_URL);
    while (currentSlot <= largest_slot) {
        const validator_info = await solana.getSlotLeaders(currentSlot, limit);
        
        const slot_leaders = {}; // slot -> leader
        validator_info.forEach((leader, index) => {
            slot_leaders[currentSlot + index] = leader.toString();
        });

        const values = Object.entries(slot_leaders).map(([slot_number, validator]) => [slot_number, validator]);
        await sql`INSERT INTO validator (slot_number, validator) VALUES ${sql(values)} ON CONFLICT (slot_number) DO NOTHING`;
        console.log(`Inserted ${values.length} validators for slot ${currentSlot} to ${currentSlot + limit}`);
        
        currentSlot += limit;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    console.log("Done");
    return;
}

function main() {
    fetch_and_store_validators();
}

main();