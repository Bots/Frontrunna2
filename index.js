// Require packages
require('dotenv').config();
const { Wallet, ethers, providers } = require('ethers');
const { FlashbotsBundleProvider, FlashbotsBundleResolution } = require('@flashbots/ethers-provider-bundle');

// Require ABIs and Bytecode
const { UniswapAbi, UniswapBytecode, UniswapFactoryAbi, UniswapFactoryBytecode, pairAbi, pairBytecode, erc20Abi, erc20Bytecode, uniswapV3Abi } = require('./abi');

// User configurable variables
const BRIBE_TO_MINERS = ethers.utils.parseUnits('20', 'gwei');
const BUY_AMOUNT = ethers.utils.parseUnits('0.1', 'ether');
const CHAIN_ID = 5;

// Providers
const httpProvider = new ethers.providers.JsonRpcProvider(process.env.HTTP_PROVIDER_URL);
const wsProvider = new ethers.providers.WebSocketProvider(process.env.WS_PROVIDER_URL);

// Set up contracts and providers
const signingWallet = new Wallet(process.env.PRIVATE_KEY).connect(wsProvider);
const uniswapV3Interface = new ethers.utils.Interface(uniswapV3Abi);
const uniswapFactory = new ethers.ContractFactory(UniswapFactoryAbi, UniswapFactoryBytecode, signingWallet).attach(process.env.UNISWAP_FACTORY_ADDRESS);
const erc20Factory = new ethers.ContractFactory(erc20Abi, erc20Bytecode, signingWallet);
const pairFactory = new ethers.ContractFactory(pairAbi, pairBytecode, signingWallet);
const uniswap = new ethers.ContractFactory(UniswapAbi, UniswapBytecode, signingWallet).attach(process.env.UNISWAP_ADDRESS);

// Decode uniswap universal router transactions
const decodeUniversalRouterSwap = (input) => {
  const abiCoder = new ethers.utils.AbiCoder();
  const decodedParameters = abiCoder.decode(['address', 'uint256', 'uint256', 'bytes', 'bool'], input);
  const breakdown = input.substring(2).match(/.{1,64}/g);

  let path = [];
  let hasTwoPath = true;
  if (breakdown.length != 9) {
    const pathOne = '0x' + breakdown[breakdown.length - 2].substring(24);
    const pathTwo = '0x' + breakdown[breakdown.length - 1].substring(24);
    path = [pathOne, pathTwo];
  } else {
    hasTwoPath = false;
  }

  return {
    recipient: parseInt(decodedParameters[(0, 16)]),
    amountIn: decodedParameters[1],
    minAmountOut: decodedParameters[2],
    path,
    hasTwoPath,
  };
};

// Set up initial checks
const initialChecks = async (tx) => {
  let transaction = null;
  let decoded = null;
  let decodedSwap = null;

  try {
    transaction = await httpProvider.getTransaction(tx);
  } catch (error) {
    console.error(error);
    return false;
  }

  if (!transaction || !transaction.to) {
    return false;
  }

  if (Number(transaction.value) == 0) return false;

  if (transaction.to.toLowerCase() != process.env.UNIVERSAL_ROUTER_ADDRESS.toLowerCase()) return false;

  try {
    decoded = uniswapV3Interface.parseTransaction(transaction);
  } catch (error) {
    console.error(error);
    return false;
  }

  // check to make sure the swap is for uniswapV2
  if (!decoded.args.commands.includes('08')) return false;
  let swapPositionInCommands = decoded.args.commands.substring(2).indexOf('08') / 2;
  let inputPosition = decoded.args.inputs[swapPositionInCommands];
  decodedSwap = decodeUniversalRouterSwap(inputPosition);
  if (!decodedSwap.hasTwoPath) return false;
  if (decodedSwap.recipient === 2) return false;
  if (decodedSwap.path[0].toLowerCase() != process.env.WETH_ADDRESS.toLowerCase()) return false;

  return {
    transaction,
    amountIn: transaction.value,
    minAmountOut: decodedSwap.minAmountOut,
    tokenToCapture: decodedSwap.path[1],
  };
};

// Process transaction
const processTransaction = async (tx) => {
  const checksPassed = await initialChecks(tx);
  if (!checksPassed) return false;
  const { transaction, amountIn, minAmountOut, tokenToCapture } = checksPassed;

  // Get and sort the reserves
  const pairAddress = await uniswapFactory.getPair(process.env.WETH_ADDRESS, tokenToCapture);
  const pair = pairFactory.attach(pairAddress);

  let reserves = null;
  try {
    reserves = await pair.getReserves();
  } catch (error) {
    console.error(error);
    return false;
  }

  let a;
  let b;
  if (process.env.WETH_ADDRESS < tokenToCapture) {
    a = reserves._reserve0;
    b = reserves._reserve1;
  } else {
    a = reserves._reserve1;
    b = reserves._reserve0;
  }

  // Get fee costs. for simplicity we'll add the user's gas fee
  const maxGasFee = transaction.maxFeePerGas ? transaction.maxFeePerGas.add(BRIBE_TO_MINERS) : BRIBE_TO_MINERS;
  const priorityFee = transaction.maxPriorityFeePerGas.add(BRIBE_TO_MINERS);

  // Buy using amount in and calculate amount out
  let firstAmountOut = await uniswap.getAmountOut(BUY_AMOUNT, a, b);
  const updatedReserveA = a.add(BUY_AMOUNT);
  const updatedReserveB = b.add(firstAmountOut);
  let secondBuyAmount = await uniswap.getAmountOut(amountIn, updatedReserveA, updatedReserveB);
  if (secondBuyAmount.lt(minAmountOut)) return console.log('Victim would get less than the minimum');
  const updatedReserveA2 = updatedReserveA.add(amountIn);
  const updatedReserveB2 = updatedReserveB.add(secondBuyAmount);
  let thirdAmountOut = await uniswap.getAmountOut(firstAmountOut, updatedReserveB2, updatedReserveA2);

  // Prepare first transaction
  const deadline = Math.floor(Date.now() / 1000) + 60 * 60; //1 hour from now
  let firstTransaction = {
    signer: signingWallet,
    transaction: await uniswap.populateTransaction.swapExactETHForTokens(firstAmountOut, [process.env.WETH_ADDRESS, tokenToCapture], signingWallet.address, deadline, {
      value: BUY_AMOUNT,
      type: 2,
      maxFeePerGas: maxGasFee,
      maxPriorityFeePerGas: priorityFee,
      gasLimit: 300000,
    }),
  };
  firstTransaction.transaction = {
    ...firstTransaction.transaction,
    chainId: CHAIN_ID,
  };

  // Prepare second transaction
  const victimsTransactionWithChainId = {
    chainId: CHAIN_ID,
    ...transaction,
  };

  const signedMiddleTransaction = {
    signedTransaction: ethers.utils.serializeTransaction(victimsTransactionWithChainId, {
      r: victimsTransactionWithChainId.r,
      s: victimsTransactionWithChainId.s,
      v: victimsTransactionWithChainId.v,
    }),
  };

  // Prepare the third transaction
  const erc20 = erc20Factory.attach(tokenToCapture);
  let thirdTransaction = {
    signer: signingWallet,
    transaction: await erc20.populateTransaction.approve(process.env.UNISWAP_ADDRESS, firstAmountOut, {
      value: '0',
      type: 2,
      maxFeePerGas: maxGasFee,
      maxPriorityFeePerGas: priorityFee,
      gasLimit: 300000,
    }),
  };
  thirdTransaction.transaction = {
    ...thirdTransaction.transaction,
    chainId: CHAIN_ID,
  };

  // Prepare the fourth transaction
  let fourthTransaction = {
    signer: signingWallet,
    transaction: await uniswap.populateTransaction.swapExactTokensForETH(firstAmountOut, thirdAmountOut, [tokenToCapture, process.env.WETH_ADDRESS], signingWallet.address, deadline, {
      value: '0',
      type: 2,
      maxFeePerGas: maxGasFee,
      maxPriorityFeePerGas: priorityFee,
      gasLimit: 300000,
    }),
  };
  fourthTransaction.transaction = {
    ...fourthTransaction.transaction,
    chainId: CHAIN_ID,
  };

  const transactionsArray = [firstTransaction, signedMiddleTransaction, thirdTransaction, fourthTransaction];

  const signedTransactions = await flashbotsProvider.signBundle(transactionsArray);
  const blockNumber = await httpProvider.getBlockNumber();
  console.log('simulating...');
  const simulation = await flashbotsProvider.simulate(signedTransactions, blockNumber + 1);
  if (simulation.firstRevert) {
    return console.log('Simulation error', simulation.firstRevert);
  } else {
    console.log('Simulation success', simulation);
  }

  // Send transactions with flashbots
  let bundleSubmission;
  flashbotsProvider
    .sendRawBundle(signedTransactions, blockNumber + 1)
    .then((_bundleSubmission) => {
      bundleSubmission = _bundleSubmission;
      console.log('Bundle submitted', bundleSubmission.bundleHash);
      return bundleSubmission.wait();
    })
    .then(async (waitResponse) => {
      console.log('Wait response', FlashbotsBundleResolution[waitResponse]);
      if (waitResponse == FlashbotsBundleResolution.BundleIncluded) {
        console.log('---------------------------------------------');
        console.log('---------------------------------------------');
        console.log('-------------- Bundle Included --------------');
        console.log('---------------------------------------------');
        console.log('---------------------------------------------');
      } else if (waitResponse == FlashbotsBundleResolution.AccountNonceTooHigh) {
        console.log('The transaction has been confirmed already');
      } else {
        console.log('Bundle hash: ', bundleSubmission.bundleHash);
        try {
          console.log({
            bundleStats: await flashbotsProvider.getBundleStats(bundleSubmission.bundleHash, blockNumber + 1),
            userStats: await flashbotsProvider.getUserStats(),
          });
        } catch (error) {
          console.error(error);
          return false;
        }
      }
    });
};

// Create the start function to listen to transactions
const start = async () => {
  flashbotsProvider = await FlashbotsBundleProvider.create(httpProvider, signingWallet, process.env.FLASHBOTS_URL);
  console.log('Listening for transactions on chain ID #', CHAIN_ID);
  wsProvider.on('pending', (tx) => {
    console.log('TX: ', tx);
    processTransaction(tx);
  });
};

start();
