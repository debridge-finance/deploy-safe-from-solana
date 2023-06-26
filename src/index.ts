import { DeBridgeSolanaClient, constants } from "@debridge-finance/solana-contracts-client";
import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import * as GnosisSafeL2 from "./abi/GnosisSafeL2.json";
import * as GnosisSafeProxyFactory from "./abi/GnosisSafeProxyFactory.json";
import Web3, { AbiFunctionFragment } from "web3";
import { helpers } from "@debridge-finance/solana-utils";
import { config } from "dotenv";

config();

const Web3RpcUrl = {
    1: 'https://mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161', // //ETH Mainnet
    42: 'https://kovan.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161', // //Kovan
    56: 'https://bsc-dataseed.binance.org/', // //BSC
    97: 'https://data-seed-prebsc-1-s1.binance.org:8545/', // //BSC Testnet
    128: 'https://http-mainnet.hecochain.com', // //Heco
    256: 'https://http-testnet.hecochain.com', // //Heco Testnet
    137: 'https://matic-mainnet.chainstacklabs.com', // //polygon
    80001: 'https://rpc-mumbai.maticvigil.com', // //polygon Testnet
    42161: 'https://arb1.arbitrum.io/rpc', // //arbitrum
    421611: 'https://rinkeby.arbitrum.io/rpc', // //arbitrum Testnet
};

function prepareGnosisExtCall(safeOwner: string, web3: Web3) {
    const singleton = "0x3e5c63644e683549055b9be8653de26e0b4cd36e";

    const setupParameters = {
        _owners: [safeOwner],
        _threshold: '1',
        to: '0x0000000000000000000000000000000000000000',
        data: '0x',
        fallbackHandler: '0xf48f2b2d2a534e402487b3ee7c18c33aec0fe5e4',
        paymentToken: '0x0000000000000000000000000000000000000000',
        payment: '0',
        paymentReceiver: '0x0000000000000000000000000000000000000000'
    };

    const setupAbi = GnosisSafeL2.abi.find((abi) => abi.name === 'setup');
    const safeInitializer = web3.eth.abi.encodeFunctionCall(setupAbi as AbiFunctionFragment, Object.values(setupParameters));


    // function createProxyWithNonce(
    //     address _singleton,
    //     bytes memory initializer,
    //     uint256 saltNonce
    // )
    const createProxyWithNonceParameters= {
        _singleton: singleton,
        initializer: safeInitializer,
        saltNonce:  Date.now()
    };
    const createProxyWithNonceAbi = GnosisSafeProxyFactory.abi.find((abi) => abi.name === 'createProxyWithNonce');
    const targetContractCalldata =  web3.eth.abi.encodeFunctionCall(createProxyWithNonceAbi as AbiFunctionFragment, Object.values(createProxyWithNonceParameters));

    // gnosisSafeProxyFactoryInstance.methods
    //         .createProxyWithNonce(
    //             tokenAddress, //address _singleton,
    //             safeInitializer, // bytes memory initializer,
    //             Date.now() //int256 saltNonce
    //         )
    //         .encodeABI();
    return { calldata: targetContractCalldata, receiver: "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2" };
}

async function getAmountWithAccountedGateTransferFee(client: DeBridgeSolanaClient, sendToChainId: number, neededAmount: bigint): Promise<bigint> {
    const [chainAddr] = client.accountsResolver.getChainSupportInfoAddress(sendToChainId);
    const chainSupportInfo = await client.getChainSupportInfoSafe(chainAddr);
    const fees = await client.getFeesOrGlobal(chainSupportInfo);
    const BPS_DENOMINATOR = 10_000n;
    const amount = (neededAmount * BPS_DENOMINATOR) / (BPS_DENOMINATOR - BigInt(fees.transferFeeBps.toString()));

    return amount;
  }

async function estimateCalldataCost(calldata: string, receiver: string, web3: Web3) {
    /**
    const gasLimit = await web3.eth.estimateGas({
        data: calldata,
        to: receiver,
    });
    const gasPrice = await web3.eth.getGasPrice();
    const predictedGasPrice = gasPrice * 130n / 100n; // 1.3
    const value = gasLimit * predictedGasPrice;
    const solAmount = calculateCrossRate(value, valuePrice, solPrice);
    return solAmount;
    */
   // pre-estimated value
   return BigInt(2* 1e7); // 0.02 sol
}   

async function main() {
    const wallet = new helpers.Wallet(Keypair.fromSecretKey(helpers.hexToBuffer(process.env.SOLANA_WALLET!)));
    const chainTo = 137;
    const web3 = new Web3(Web3RpcUrl[chainTo]);
    const conn = new Connection(clusterApiUrl("mainnet-beta"));
    // @ts-ignore
    const client = new DeBridgeSolanaClient(conn, wallet, {
        programId: "DEbrdGj3HsRsAzx6uH4MKyREKxVAfBydijLUF3ygsFfh",
        settingsProgramId: "DeSetTwWhjZq6Pz9Kfdo1KoS5NqtsM6G8ERbX4SSCSft",
    });
    console.log(`Initialized client`);
    const safeOwner = "0xfAC8EeA7f91DAde441876118AF8Af5C16e35f406";
    const { receiver, calldata } = prepareGnosisExtCall(safeOwner, web3);
    console.log(`Got calldata: ${calldata}`);
    const executionFee = await estimateCalldataCost(calldata, receiver, web3);
    const amountToSend = await getAmountWithAccountedGateTransferFee(client, chainTo, executionFee );
    console.log(`Estimated execution fee: ${executionFee}, with accounted transfer fee: ${ amountToSend }`);
    const { transaction, extCallStorage } = await client.buildSendInstruction(
        wallet.publicKey, null, amountToSend, new PublicKey("So11111111111111111111111111111111111111112"), receiver, 
        chainTo, false, 0, safeOwner, constants.REVERT_IF_EXTERNAL_FAIL, executionFee, calldata
    );
    console.log(`Built initExtCall & send instructions`)
    if (extCallStorage.length !== 0) {
        console.log(`Initializing external call...`);
        const txHashes = await client.storeExternallCall(extCallStorage, calldata);
        console.log(`Sent ext call init transactions: ${txHashes.join(", ")}`);
    }
    console.log(`Sending message...`);
    const txId = await helpers.sendAll(conn, wallet, transaction);
    console.log(`Sent tx: ${txId}`);
}

main().catch(console.error)