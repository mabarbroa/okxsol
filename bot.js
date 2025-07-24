const { Connection, Keypair, PublicKey, Transaction } = require('@solana/web3.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

class OKXAutoSwapBot {
    constructor(config) {
        this.config = config;
        this.connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
        this.apiUrl = 'https://www.okx.com/api/v5/dex/aggregator';
        this.wallet = this.loadWallet();
        this.isRunning = false;
        this.tradeCount = 0;
        this.maxDailyTrades = config.maxDailyTrades || 50;
        
        console.log(`🚀 Bot initialized for wallet: ${this.wallet.publicKey.toString()}`);
        console.log(`📊 Trading pair: SOL → PUMP`);
        console.log(`💰 Amount per trade: ${config.amount / 1000000000} SOL`);
    }

    // Load wallet dari account.txt
    loadWallet() {
        try {
            const accountPath = path.join(__dirname, 'account.txt');
            const privateKeyString = fs.readFileSync(accountPath, 'utf8').trim();
            
            // Support berbagai format private key
            let privateKeyBytes;
            if (privateKeyString.includes('[') && privateKeyString.includes(']')) {
                // Format array: [1,2,3,...]
                privateKeyBytes = JSON.parse(privateKeyString);
            } else if (privateKeyString.includes(',')) {
                // Format comma separated: 1,2,3,...
                privateKeyBytes = privateKeyString.split(',').map(x => parseInt(x.trim()));
            } else {
                // Format base58 atau hex
                privateKeyBytes = Buffer.from(privateKeyString, 'base64');
            }
            
            return Keypair.fromSecretKey(new Uint8Array(privateKeyBytes));
        } catch (error) {
            console.error('❌ Error loading wallet from account.txt:', error.message);
            console.log('💡 Pastikan file account.txt berisi private key dalam format yang benar');
            process.exit(1);
        }
    }

    // Cek balance wallet
    async checkBalance() {
        try {
            const balance = await this.connection.getBalance(this.wallet.publicKey);
            const solBalance = balance / 1000000000;
            console.log(`💰 Current SOL balance: ${solBalance.toFixed(4)} SOL`);
            return balance;
        } catch (error) {
            console.error('❌ Error checking balance:', error.message);
            return 0;
        }
    }

    // Get swap quote dari OKX DEX API
    async getSwapQuote(fromToken, toToken, amount) {
        try {
            const response = await axios.get(`${this.apiUrl}/quote`, {
                params: {
                    chainId: '501', // Solana
                    fromTokenAddress: fromToken,
                    toTokenAddress: toToken,
                    amount: amount.toString(),
                    slippage: this.config.slippage || '1'
                },
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            if (response.data.code === '0') {
                return response.data.data[0];
            } else {
                throw new Error(`API Error: ${response.data.msg}`);
            }
        } catch (error) {
            console.error('❌ Error getting quote:', error.message);
            throw error;
        }
    }

    // Execute swap transaction
    async executeSwap(quoteData) {
        try {
            const swapResponse = await axios.post(`${this.apiUrl}/swap`, {
                chainId: '501',
                fromTokenAddress: quoteData.fromToken.tokenContractAddress,
                toTokenAddress: quoteData.toToken.tokenContractAddress,
                amount: quoteData.fromTokenAmount,
                slippage: this.config.slippage || '1',
                userWalletAddress: this.wallet.publicKey.toString(),
                referrer: ''
            }, {
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            if (swapResponse.data.code !== '0') {
                throw new Error(`Swap API Error: ${swapResponse.data.msg}`);
            }

            const txData = swapResponse.data.data[0];
            const transaction = Transaction.from(Buffer.from(txData.tx, 'base64'));
            
            // Sign dan send transaction
            transaction.partialSign(this.wallet);
            const signature = await this.connection.sendRawTransaction(transaction.serialize(), {
                skipPreflight: false,
                preflightCommitment: 'confirmed'
            });

            console.log(`📤 Transaction sent: ${signature}`);
            
            // Confirm transaction
            const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');
            
            if (confirmation.value.err) {
                throw new Error(`Transaction failed: ${confirmation.value.err}`);
            }

            return signature;
        } catch (error) {
            console.error('❌ Error executing swap:', error.message);
            throw error;
        }
    }

    // Cek kondisi trading
    async shouldTrade() {
        try {
            // Cek daily trade limit
            if (this.tradeCount >= this.maxDailyTrades) {
                console.log('⏰ Daily trade limit reached');
                return false;
            }

            // Cek balance minimum
            const balance = await this.checkBalance();
            const requiredBalance = this.config.amount + (0.01 * 1000000000); // Amount + gas fee
            
            if (balance < requiredBalance) {
                console.log('💸 Insufficient balance for trade');
                return false;
            }

            // Get current quote untuk analisis
            const quote = await this.getSwapQuote(
                this.config.fromToken,
                this.config.toToken,
                this.config.amount
            );

            const expectedPump = parseInt(quote.toTokenAmount);
            const minExpected = this.config.minExpectedAmount || 0;

            console.log(`📈 Current quote: ${expectedPump / 1000000} PUMP tokens`);
            
            // Trading logic - bisa disesuaikan
            if (expectedPump >= minExpected) {
                return true;
            }

            return false;
        } catch (error) {
            console.error('❌ Error in shouldTrade:', error.message);
            return false;
        }
    }

    // Perform auto swap
    async performSwap() {
        try {
            console.log('🔄 Starting swap process...');
            
            const quote = await this.getSwapQuote(
                this.config.fromToken,
                this.config.toToken,
                this.config.amount
            );

            console.log(`💱 Swapping ${this.config.amount / 1000000000} SOL → ${parseInt(quote.toTokenAmount) / 1000000} PUMP`);
            
            const signature = await this.executeSwap(quote);
            
            this.tradeCount++;
            console.log(`✅ Swap completed! TX: https://solscan.io/tx/${signature}`);
            console.log(`📊 Total trades today: ${this.tradeCount}/${this.maxDailyTrades}`);
            
            return signature;
        } catch (error) {
            console.error('❌ Swap failed:', error.message);
            throw error;
        }
    }

    // Main monitoring loop
    async start() {
        console.log('🤖 Starting OKX Auto Swap Bot...');
        this.isRunning = true;

        while (this.isRunning) {
            try {
                console.log(`\n⏰ ${new Date().toLocaleString()} - Checking trading conditions...`);
                
                const shouldTrade = await this.shouldTrade();
                
                if (shouldTrade) {
                    await this.performSwap();
                    
                    // Cooldown setelah trade
                    console.log(`😴 Cooldown for ${this.config.tradeCooldown / 1000} seconds...`);
                    await this.sleep(this.config.tradeCooldown);
                } else {
                    console.log('⏳ Conditions not met, waiting...');
                }
                
                // Interval check
                await this.sleep(this.config.checkInterval);
                
            } catch (error) {
                console.error('❌ Error in main loop:', error.message);
                console.log('🔄 Retrying in 30 seconds...');
                await this.sleep(30000);
            }
        }
    }

    // Stop bot
    stop() {
        console.log('🛑 Stopping bot...');
        this.isRunning = false;
    }

    // Sleep utility
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Konfigurasi bot
const botConfig = {
    fromToken: '11111111111111111111111111111111', // SOL
    toToken: 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn', // PUMP token
    amount: 100000000, // 0.1 SOL per trade (dalam lamports)
    minExpectedAmount: 1000000, // Minimum PUMP tokens expected
    slippage: '2', // 2% slippage tolerance
    checkInterval: 60000, // Check setiap 1 menit
    tradeCooldown: 300000, // 5 menit cooldown setelah trade
    maxDailyTrades: 20 // Maximum 20 trades per day
};

// Jalankan bot
const bot = new OKXAutoSwapBot(botConfig);

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Received SIGINT, shutting down gracefully...');
    bot.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
    bot.stop();
    process.exit(0);
});

// Start the bot
bot.start().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
});

console.log(`
🤖 OKX Auto Swap Bot Started!
📝 Configuration:
   - Trading Pair: SOL → PUMP
   - Amount per trade: ${botConfig.amount / 1000000000} SOL
   - Check interval: ${botConfig.checkInterval / 1000} seconds
   - Max daily trades: ${botConfig.maxDailyTrades}
   - Slippage tolerance: ${botConfig.slippage}%

Press Ctrl+C to stop the bot
`);
