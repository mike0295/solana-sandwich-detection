import json

class TokenTransfer:
    def __init__(self, mint, amount, from_authority, from_address, to_address):
        self.mint = mint
        self.amount = amount
        self.from_authority = from_authority
        self.from_address = from_address
        self.to_address = to_address
    
    def __str__(self):
        return f"TokenTransfer(mint={self.mint}, amount={self.amount}, from_authority={self.from_authority}, from_address={self.from_address}, to_address={self.to_address})"

class SwapDetails:
    def __init__(self, swapper, token_in, amount_in, token_out, amount_out):
        self.swapper = swapper
        self.token_in = token_in
        self.amount_in = amount_in
        self.token_out = token_out
        self.amount_out = amount_out
    
    def __str__(self):
        return f"SwapDetails(swapper={self.swapper}, token_in={self.token_in}, amount_in={self.amount_in}, token_out={self.token_out}, amount_out={self.amount_out})"

def extract_balance_changes(transaction):
    balance_changes = []
    pre_balances = transaction['meta']['preTokenBalances']
    post_balances = transaction['meta']['postTokenBalances']
    pre_balances_dict = {pre_balance['accountIndex']: pre_balance for pre_balance in pre_balances}
    post_balances_dict = {post_balance['accountIndex']: post_balance for post_balance in post_balances}

    for account_index in post_balances_dict.keys():
        if account_index not in pre_balances_dict:
            balance_changes.append((post_balances_dict[account_index]['mint'], int(post_balances_dict[account_index]['uiTokenAmount']['amount'])))
            continue

        balance_delta = int(post_balances_dict[account_index]['uiTokenAmount']['amount']) - int(pre_balances_dict[account_index]['uiTokenAmount']['amount'])
        if balance_delta == 0:
            continue

        balance_changes.append((post_balances_dict[account_index]['mint'], abs(balance_delta)))
    
    return balance_changes


def extract_swap_details(transaction):
    # first transfer is transfer out
    # second transfer is transfer in
    balance_changes = extract_balance_changes(transaction)

    instructions = [] 
    for inner_instruction in transaction['meta']['innerInstructions']:
        for instruction in inner_instruction['instructions']:
            instructions.append(instruction)

    token_transfers = []
    for instruction in instructions:
        if 'parsed' not in instruction or instruction['program'] != 'spl-token':
            continue
        
        parsed_info = instruction['parsed']['info']
        if instruction['parsed']['type'] == 'transfer':
            token_transfer = TokenTransfer(None, parsed_info['amount'], parsed_info['authority'], parsed_info['source'], parsed_info['destination'])
            for balance_change in balance_changes:
                if balance_change[1] == int(token_transfer.amount):
                    token_transfer.mint = balance_change[0]
                    break
            token_transfers.append(token_transfer)
        elif instruction['parsed']['type'] == 'transferChecked':
            token_transfer = TokenTransfer(parsed_info['mint'], parsed_info['tokenAmount']['amount'], parsed_info['authority'], parsed_info['source'], parsed_info['destination'])
            token_transfers.append(token_transfer)
    
    if len(token_transfers) != 2:
        print("Error: Incorrect number of token transfers", len(token_transfers), transaction['transaction']['signatures'][0])
        return None

    return SwapDetails(token_transfers[0].from_authority, token_transfers[0].mint, token_transfers[0].amount, token_transfers[1].mint, token_transfers[1].amount)

def is_sandwich(transactions):
    if len(transactions) != 3:
        return False

    signer_1 = transactions[0]['transaction']['message']['accountKeys'][0]['pubkey']
    signer_2 = transactions[1]['transaction']['message']['accountKeys'][0]['pubkey']
    signer_3 = transactions[2]['transaction']['message']['accountKeys'][0]['pubkey']

    if signer_1 != signer_3:
        return False

    swap_details_list = []
    for transaction in transactions:
        swap_details = extract_swap_details(transaction)
        if swap_details is None:
            print("Error: Incorrect swap details", transaction['transaction']['signatures'][0])
            return False
        swap_details_list.append(swap_details)

    frontrun_swap_details = swap_details_list[0]
    victim_swap_details = swap_details_list[1]
    backrun_swap_details = swap_details_list[2]

    if frontrun_swap_details.token_in == backrun_swap_details.token_out and \
        frontrun_swap_details.token_out == backrun_swap_details.token_in and \
        frontrun_swap_details.swapper != victim_swap_details.swapper and \
        backrun_swap_details.swapper != victim_swap_details.swapper and \
        frontrun_swap_details.token_in == victim_swap_details.token_in and \
        frontrun_swap_details.token_out == victim_swap_details.token_out and \
        frontrun_swap_details.amount_out == backrun_swap_details.amount_in:
        return True

    return False

if __name__ == '__main__':
    with open('SOLANA_MAINNET-BLOCK-304707398.json', 'r') as file:
        data = json.load(file)

    transactions = data[0]['transactions']

    non_vote_transactions = {}
    for idx, transaction in enumerate(transactions):
        # filter out vote transactions
        if transaction['transaction']['message']['instructions'][0]['programId'] != 'Vote111111111111111111111111111111111111111':
            if transaction['meta']['err'] is None:
                non_vote_transactions[idx] = transaction

    swap_transactions = {}
    for idx, transaction in non_vote_transactions.items():
        for log_message in transaction['meta']['logMessages']:
            if 'swap' in log_message.lower() or 'ray_log' in log_message.lower():
                swap_transactions[idx] = transaction
                break

    sandwich_transactions = []
    for idx, transaction in swap_transactions.items():
        if idx+1 in swap_transactions and idx+2 in swap_transactions:
            signer_1 = transaction['transaction']['message']['accountKeys'][0]['pubkey']
            signer_2 = swap_transactions[idx+1]['transaction']['message']['accountKeys'][0]['pubkey']
            signer_3 = swap_transactions[idx+2]['transaction']['message']['accountKeys'][0]['pubkey']
            if is_sandwich([transaction, swap_transactions[idx+1], swap_transactions[idx+2]]):
                sandwich_transaction = {
                    'slot_number': data[0]['parentSlot']+1,
                    'block_time': data[0]['blockTime'],
                    'blockhash': data[0]['blockhash'],
                    'frontrun_tx': swap_transactions[idx]['transaction']['signatures'][0],
                    'victim_tx': swap_transactions[idx+1]['transaction']['signatures'][0],
                    'backrun_tx': swap_transactions[idx+2]['transaction']['signatures'][0],
                    'attacker': signer_1
                }
                sandwich_transactions.append(sandwich_transaction)

    print(sandwich_transactions)