import { data } from './SOLANA_MAINNET-BLOCK-304934283.json' assert { type: 'json' };

function extract_balance_changes(transaction) {
    const balanceChanges = [];
    const preBalances = transaction.meta.preTokenBalances;
    const postBalances = transaction.meta.postTokenBalances;
    
    const preBalancesDict = {};
    for (const preBalance of preBalances) {
        preBalancesDict[preBalance.accountIndex] = preBalance;
    }
    
    const postBalancesDict = {};
    for (const postBalance of postBalances) {
        postBalancesDict[postBalance.accountIndex] = postBalance;
    }

    for (const accountIndex in postBalancesDict) {
        if (!(accountIndex in preBalancesDict)) {
            balanceChanges.push([
                postBalancesDict[accountIndex].mint,
                parseInt(postBalancesDict[accountIndex].uiTokenAmount.amount)
            ]);
            continue;
        }

        const balanceDelta = parseInt(postBalancesDict[accountIndex].uiTokenAmount.amount) - 
                            parseInt(preBalancesDict[accountIndex].uiTokenAmount.amount);
        
        if (balanceDelta === 0) {
            continue;
        }

        balanceChanges.push([
            postBalancesDict[accountIndex].mint,
            Math.abs(balanceDelta)
        ]);
    }

    return balanceChanges;
}

function extract_swap_details(transaction) {
    // first transfer is transfer out
    // second transfer is transfer in
    const balanceChanges = extract_balance_changes(transaction);

    const instructions = [];
    for (const innerInstruction of transaction.meta.innerInstructions) {
        for (const instruction of innerInstruction.instructions) {
            instructions.push(instruction);
        }
    }

    const tokenTransfers = [];
    for (const instruction of instructions) {
        if (!instruction.parsed || instruction.program !== 'spl-token') {
            continue;
        }

        const parsedInfo = instruction.parsed.info;
        if (instruction.parsed.type === 'transfer') {
            const tokenTransfer = {
                mint: null,
                amount: parsedInfo.amount,
                from_authority: parsedInfo.authority,
                from_address: parsedInfo.source,
                to_address: parsedInfo.destination
            };
            
            for (const balanceChange of balanceChanges) {
                if (balanceChange[1] === parseInt(tokenTransfer.amount)) {
                    tokenTransfer.mint = balanceChange[0];
                    break;
                }
            }
            tokenTransfers.push(tokenTransfer);
        } else if (instruction.parsed.type === 'transferChecked') {
            const tokenTransfer = {
                mint: parsedInfo.mint,
                amount: parsedInfo.tokenAmount.amount,
                from_authority: parsedInfo.authority, 
                from_address: parsedInfo.source,
                to_address: parsedInfo.destination
            };
            tokenTransfers.push(tokenTransfer);
        }
    }

    if (tokenTransfers.length !== 2) {
        console.log("Error: Incorrect number of token transfers", tokenTransfers.length, transaction.transaction.signatures[0]);
        return null;
    }

    return {
        swapper: tokenTransfers[0].from_authority,
        token_in: tokenTransfers[0].mint,
        amount_in: tokenTransfers[0].amount,
        token_out: tokenTransfers[1].mint,
        amount_out: tokenTransfers[1].amount
    };
}

function is_sandwich(transactions) {
    if (transactions.length !== 3) {
        return false;
    }

    const signer1 = transactions[0].transaction.message.accountKeys[0].pubkey;
    const signer2 = transactions[1].transaction.message.accountKeys[0].pubkey;
    const signer3 = transactions[2].transaction.message.accountKeys[0].pubkey;

    if (signer1 !== signer3) {
        return false;
    }

    const swapDetailsList = [];
    for (const transaction of transactions) {
        const swapDetails = extract_swap_details(transaction);
        if (swapDetails === null) {
            console.log("Error: Incorrect swap details", transaction.transaction.signatures[0]);
            return false;
        }
        swapDetailsList.push(swapDetails);
    }

    const frontrunSwapDetails = swapDetailsList[0];
    const victimSwapDetails = swapDetailsList[1];
    const backrunSwapDetails = swapDetailsList[2];

    if (frontrunSwapDetails.token_in === backrunSwapDetails.token_out &&
        frontrunSwapDetails.token_out === backrunSwapDetails.token_in &&
        frontrunSwapDetails.swapper !== victimSwapDetails.swapper &&
        backrunSwapDetails.swapper !== victimSwapDetails.swapper &&
        frontrunSwapDetails.token_in === victimSwapDetails.token_in &&
        frontrunSwapDetails.token_out === victimSwapDetails.token_out &&
        frontrunSwapDetails.amount_in < backrunSwapDetails.amount_out &&
        frontrunSwapDetails.amount_out >= backrunSwapDetails.amount_in
    ) {
        return true;
    }

    return false;
}

function extract_sandwich_transactions(data) {
    if (!data || data.length == 0 || data[0] == null) {
        return {"data":null}
    }
    const transactions = data[0].transactions;

    const nonVoteTransactions = {};
    transactions.forEach((transaction, idx) => {
        // filter out vote transactions
        if (transaction.transaction.message.instructions[0] && transaction.transaction.message.instructions[0].programId !== 'Vote111111111111111111111111111111111111111') {
            if (transaction.meta.err === null) {
                nonVoteTransactions[idx] = transaction;
            }
        }
    });

    const swapTransactions = {};
    Object.entries(nonVoteTransactions).forEach(([idx, transaction]) => {
        for (const logMessage of transaction.meta.logMessages) {
            if (logMessage.toLowerCase().includes('swap') || logMessage.toLowerCase().includes('ray_log')) {
                swapTransactions[idx] = transaction;
                break;
            }
        }
    });

    const sandwichTransactions = [];
    Object.entries(swapTransactions).forEach(([idx, transaction]) => {
        const nextIdx = parseInt(idx) + 1;
        const nextNextIdx = parseInt(idx) + 2;
        
        if (swapTransactions[nextIdx] && swapTransactions[nextNextIdx]) {
            const signer1 = transaction.transaction.message.accountKeys[0].pubkey;

            if (is_sandwich([transaction, swapTransactions[nextIdx], swapTransactions[nextNextIdx]])) {
                const sandwichTransaction = {
                    slot_number: data[0].parentSlot + 1,
                    block_time: data[0].blockTime,
                    blockhash: data[0].blockhash,
                    frontrun_tx: swapTransactions[idx].transaction.signatures[0],
                    victim_tx: swapTransactions[nextIdx].transaction.signatures[0], 
                    backrun_tx: swapTransactions[nextNextIdx].transaction.signatures[0],
                    attacker: signer1
                };
                sandwichTransactions.push(sandwichTransaction);
            }
        }
    });

    return {"data": sandwichTransactions};
}

console.log(extract_sandwich_transactions(data));
