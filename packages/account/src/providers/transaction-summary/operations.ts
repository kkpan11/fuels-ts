import { ZeroBytes32 } from '@fuel-ts/address/configs';
import { ErrorCode, FuelError } from '@fuel-ts/errors';
import type { BN } from '@fuel-ts/math';
import { bn, toBytes } from '@fuel-ts/math';
import { ReceiptType, TransactionCoder, TransactionType } from '@fuel-ts/transactions';
import type { InputContract, Output, OutputChange, Input } from '@fuel-ts/transactions';
import { arrayify, concat } from '@fuel-ts/utils';

import type {
  TransactionResultReceipt,
  TransactionResultCallReceipt,
  TransactionResultMessageOutReceipt,
  TransactionResultTransferOutReceipt,
  TransactionResultTransferReceipt,
} from '../transaction-response';

import { getFunctionCall, type FunctionCall } from './call';
import {
  getInputFromAssetId,
  getInputAccountAddress,
  getInputContractFromIndex,
  getInputsContract,
  getInputsCoinAndMessage,
  aggregateInputsAmountsByAssetAndOwner,
} from './input';
import {
  getOutputsChange,
  getOutputsCoin,
  getOutputsContract,
  getOutputsContractCreated,
} from './output';
import { AddressType, ChainName, OperationName, TransactionTypeName } from './types';
import type {
  InputOutputParam,
  InputParam,
  OperationCoin,
  RawPayloadParam,
  ReceiptParam,
  Operation,
  GetOperationParams,
  GetTransferOperationsParams,
  AbiMap,
} from './types';

/**
 * Extracts a specific type of receipt from a list of receipts.
 *
 * @param receipts - The list of receipts to filter.
 * @param type - The type of receipt to filter for.
 * @returns The filtered list of receipts.
 */
export function getReceiptsByType<T = TransactionResultReceipt>(
  receipts: TransactionResultReceipt[],
  type: ReceiptType
) {
  return (receipts ?? []).filter((r) => r.type === type) as T[];
}

/**
 * Returns the transaction type's name based on the transaction type enum value.
 *
 * @param transactionType - The transaction type enum value.
 * @returns The transaction type's name.
 */
export function getTransactionTypeName(transactionType: TransactionType): TransactionTypeName {
  switch (transactionType) {
    case TransactionType.Mint:
      return TransactionTypeName.Mint;
    case TransactionType.Create:
      return TransactionTypeName.Create;
    case TransactionType.Script:
      return TransactionTypeName.Script;
    case TransactionType.Blob:
      return TransactionTypeName.Blob;
    case TransactionType.Upgrade:
      return TransactionTypeName.Upgrade;
    case TransactionType.Upload:
      return TransactionTypeName.Upload;
    default:
      throw new FuelError(
        ErrorCode.UNSUPPORTED_TRANSACTION_TYPE,
        `Unsupported transaction type: ${transactionType}.`
      );
  }
}

/** @hidden */
export function isType(transactionType: TransactionType, type: TransactionTypeName) {
  const txType = getTransactionTypeName(transactionType);

  return txType === type;
}

/** @hidden */
export function isTypeMint(transactionType: TransactionType) {
  return isType(transactionType, TransactionTypeName.Mint);
}

/** @hidden */
export function isTypeCreate(transactionType: TransactionType) {
  return isType(transactionType, TransactionTypeName.Create);
}

/** @hidden */
export function isTypeScript(transactionType: TransactionType) {
  return isType(transactionType, TransactionTypeName.Script);
}

/** @hidden */
export function isTypeUpgrade(transactionType: TransactionType) {
  return isType(transactionType, TransactionTypeName.Upgrade);
}

/** @hidden */
export function isTypeUpload(transactionType: TransactionType) {
  return isType(transactionType, TransactionTypeName.Upload);
}

/** @hidden */
export function isTypeBlob(transactionType: TransactionType) {
  return isType(transactionType, TransactionTypeName.Blob);
}

/** @hidden */
export function hasSameAssetId(a: OperationCoin) {
  return (b: OperationCoin) => a.assetId === b.assetId;
}

/** @hidden */
export function getReceiptsCall(receipts: TransactionResultReceipt[]) {
  return getReceiptsByType<TransactionResultCallReceipt>(receipts, ReceiptType.Call);
}

/** @hidden */
export function getReceiptsMessageOut(receipts: TransactionResultReceipt[]) {
  return getReceiptsByType<TransactionResultMessageOutReceipt>(receipts, ReceiptType.MessageOut);
}

/** @hidden */
function mergeAssets(op1: Operation, op2: Operation): OperationCoin[] {
  const assets1 = op1.assetsSent || [];
  const assets2 = op2.assetsSent || [];

  const assetMap = new Map<string, OperationCoin>();

  // Merge assets from op1
  assets1.forEach((asset) => {
    assetMap.set(asset.assetId, { ...asset });
  });

  // Merge assets from op2, adding to existing assets or creating new ones
  assets2.forEach((asset) => {
    const existingAsset = assetMap.get(asset.assetId);
    if (existingAsset) {
      existingAsset.amount = bn(existingAsset.amount).add(asset.amount);
    } else {
      assetMap.set(asset.assetId, { ...asset });
    }
  });

  return Array.from(assetMap.values());
}

/** @hidden */
function isSameOperation(a: Operation, b: Operation) {
  return (
    a.name === b.name &&
    a.from?.address === b.from?.address &&
    a.to?.address === b.to?.address &&
    a.from?.type === b.from?.type &&
    a.to?.type === b.to?.type
  );
}

/** @hidden */
function mergeAssetsSent(existing: Operation, toAdd: Operation): Operation['assetsSent'] {
  if (!toAdd.assetsSent?.length) {
    return existing.assetsSent;
  }

  return existing.assetsSent?.length ? mergeAssets(existing, toAdd) : toAdd.assetsSent;
}

/** @hidden */
function mergeCalls(existing: Operation, toAdd: Operation): Operation['calls'] {
  if (!toAdd.calls?.length) {
    return existing.calls;
  }

  return [...(existing.calls || []), ...toAdd.calls];
}

/** @hidden */
function mergeOperations(existing: Operation, toAdd: Operation): Operation {
  return {
    ...existing,
    assetsSent: mergeAssetsSent(existing, toAdd),
    calls: mergeCalls(existing, toAdd),
    receipts: [
      ...(existing.receipts || []),
      ...(toAdd.receipts?.filter((r) => !existing.receipts?.some((er) => er === r)) || []),
    ],
  };
}

/** @hidden */
export function addOperation(operations: Operation[], toAdd: Operation): Operation[] {
  const existingIndex = operations.findIndex((op) => isSameOperation(op, toAdd));

  if (existingIndex === -1) {
    return [...operations, toAdd];
  }

  return operations.map((op, index) => (index === existingIndex ? mergeOperations(op, toAdd) : op));
}

/** @hidden */
export function getReceiptsTransferOut(receipts: TransactionResultReceipt[]) {
  return getReceiptsByType<TransactionResultTransferOutReceipt>(receipts, ReceiptType.TransferOut);
}

/**
 * Creates withdrawal operations from Fuel to Ethereum based on message out receipts
 *
 * @param inputs - Transaction inputs containing account information
 * @param receipts - Transaction receipts containing withdrawal details
 * @param baseAssetId - The ID of the asset being withdrawn
 * @returns Array of withdrawal operations with sender, recipient, and asset id.
 */
export function getWithdrawFromFuelOperations({
  inputs,
  receipts,
  baseAssetId,
}: InputParam & ReceiptParam & { baseAssetId: string }): Operation[] {
  const messageOutReceipts = getReceiptsMessageOut(receipts);

  const withdrawFromFuelOperations = messageOutReceipts.reduce(
    (prevWithdrawFromFuelOps, receipt) => {
      const input = getInputFromAssetId(inputs, baseAssetId, true);
      if (input) {
        const inputAddress = getInputAccountAddress(input);
        const newWithdrawFromFuelOps = addOperation(prevWithdrawFromFuelOps, {
          name: OperationName.withdrawFromFuel,
          from: {
            type: AddressType.account,
            address: inputAddress,
          },
          to: {
            type: AddressType.account,
            address: receipt.recipient.toString(),
            chain: ChainName.ethereum,
          },
          assetsSent: [
            {
              amount: receipt.amount,
              assetId: baseAssetId,
            },
          ],
          receipts: [receipt],
        });

        return newWithdrawFromFuelOps;
      }

      return prevWithdrawFromFuelOps;
    },
    [] as Operation[]
  );

  return withdrawFromFuelOperations;
}

/** @hidden */
function findBytesSegmentIndex(whole: Uint8Array, segment: Uint8Array) {
  for (let i = 0; i <= whole.length - segment.length; i++) {
    let match = true;
    for (let j = 0; j < segment.length; j++) {
      if (whole[i + j] !== segment[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      return i;
    }
  }
  return -1;
}

/** @hidden */
function getContractCalls(
  contractInput: InputContract,
  abiMap: AbiMap | undefined,
  receipt: TransactionResultCallReceipt,
  scriptData?: Uint8Array
): FunctionCall[] {
  const calls: FunctionCall[] = [];

  const abi = abiMap?.[contractInput.contractID];
  if (!abi || !scriptData) {
    return calls;
  }

  const bytesSegment = concat([
    arrayify(receipt.to), // Contract ID (32 bytes)
    toBytes(receipt.param1.toHex(), 8), // Function selector offset (8 bytes)
    toBytes(receipt.param2.toHex(), 8), // Function args offset (8 bytes)
  ]);

  const segmentIndex = findBytesSegmentIndex(scriptData, bytesSegment);

  /**
   * If the byte segment is not found, it likely indicates a non-standard contract call, such as:
   *
   * 1. Manual External Call: A direct call from a Sway script or contract using
   *    `abi(abi_interface, contract_id)` built-in Sway function.
   *
   * 2. Inline ASM Call: A call made using the ASM `call` instruction in Sway,
   *    without setting `param1` and `param2` offsets just like the SDKs do.
   *
   * In these cases, the function call cannot be decoded.
   */
  const canDecodeFunctionCall = segmentIndex !== -1;

  if (!canDecodeFunctionCall) {
    return calls;
  }

  const offset = segmentIndex + bytesSegment.length;

  const call = getFunctionCall({ abi, receipt, offset, scriptData });
  calls.push(call);

  return calls;
}

/** @hidden */
function getAssetsSent(receipt: TransactionResultCallReceipt): OperationCoin[] | undefined {
  return receipt.amount?.isZero()
    ? undefined
    : [
        {
          amount: receipt.amount,
          assetId: receipt.assetId,
        },
      ];
}

/** @hidden */
function processCallReceipt(
  receipt: TransactionResultCallReceipt,
  contractInput: InputContract,
  inputs: Input[],
  abiMap: AbiMap | undefined,
  scriptData: Uint8Array | undefined,
  baseAssetId: string
): Operation[] {
  const assetId = receipt.assetId === ZeroBytes32 ? baseAssetId : receipt.assetId;
  const input = getInputFromAssetId(inputs, assetId, assetId === baseAssetId);
  if (!input) {
    return [];
  }

  const inputAddress = getInputAccountAddress(input);
  const calls = getContractCalls(contractInput, abiMap, receipt, scriptData);

  return [
    {
      name: OperationName.contractCall,
      from: {
        type: AddressType.account,
        address: inputAddress,
      },
      to: {
        type: AddressType.contract,
        address: receipt.to,
      },
      assetsSent: getAssetsSent(receipt),
      calls,
      receipts: [receipt],
    },
  ];
}

/** @hidden */
export function getContractCallOperations({
  inputs,
  outputs,
  receipts,
  abiMap,
  rawPayload,
  baseAssetId,
}: InputOutputParam &
  ReceiptParam &
  Pick<GetOperationParams, 'abiMap' | 'maxInputs' | 'baseAssetId'> &
  RawPayloadParam): Operation[] {
  const contractCallReceipts = getReceiptsCall(receipts);
  const contractOutputs = getOutputsContract(outputs);

  return contractOutputs.flatMap((output) => {
    const contractInput = getInputContractFromIndex(inputs, output.inputIndex);
    if (!contractInput) {
      return [];
    }

    let scriptData: Uint8Array | undefined;

    if (rawPayload) {
      const [transaction] = new TransactionCoder().decode(arrayify(rawPayload), 0);
      if (transaction.type === TransactionType.Script) {
        scriptData = arrayify(transaction.scriptData as string);
      }
    }

    return contractCallReceipts
      .filter((receipt) => receipt.to === contractInput.contractID)
      .flatMap((receipt) =>
        processCallReceipt(receipt, contractInput, inputs, abiMap, scriptData, baseAssetId)
      );
  });
}

/**
 * Extracts a transfer operation from a transaction receipt, determining the addresses and types
 * of the sender and receiver, along with the transferred asset details.
 *
 * @param receipt - The transaction receipt containing transfer information
 * @param contractInputs - Array of contract inputs to determine address types
 * @param changeOutputs - Array of change outputs to resolve zero addresses
 * @returns A transfer operation object with sender, receiver and asset details
 */
function extractTransferOperationFromReceipt(
  receipt: TransactionResultTransferReceipt | TransactionResultTransferOutReceipt,
  contractInputs: InputContract[],
  changeOutputs: OutputChange[]
) {
  const { to: toAddress, assetId, amount } = receipt;
  let { id: fromAddress } = receipt;

  const toType = contractInputs.some((input) => input.contractID === toAddress)
    ? AddressType.contract
    : AddressType.account;

  if (ZeroBytes32 === fromAddress) {
    const change = changeOutputs.find((output) => output.assetId === assetId);

    fromAddress = change?.to || fromAddress;
  }

  const fromType = contractInputs.some((input) => input.contractID === fromAddress)
    ? AddressType.contract
    : AddressType.account;

  return {
    name: OperationName.transfer,
    from: {
      type: fromType,
      address: fromAddress,
    },
    to: {
      type: toType,
      address: toAddress,
    },
    assetsSent: [
      {
        assetId: assetId.toString(),
        amount,
      },
    ],
    receipts: [receipt],
  };
}

/** @hidden */
export function getTransferOperations({
  inputs,
  outputs,
  receipts,
  baseAssetId,
}: GetTransferOperationsParams): Operation[] {
  let operations: Operation[] = [];

  const coinOutputs = getOutputsCoin(outputs);
  const contractInputs = getInputsContract(inputs);
  const changeOutputs = getOutputsChange(outputs);

  const aggregated = aggregateInputsAmountsByAssetAndOwner(inputs, baseAssetId);

  /**
   * Extracting transfer operations between wallets, as they do not produce receipts
   */
  coinOutputs.forEach(({ amount, assetId, to }) => {
    const txPayers = aggregated.get(assetId) || new Map<string, BN>();
    let selectedPayer: string | undefined;
    let fallbackPayer: string | undefined;

    for (const [address, payedAmount] of txPayers) {
      if (!fallbackPayer) {
        fallbackPayer = address; // Set the first payer as a fallback
      }

      if (payedAmount.gte(amount)) {
        selectedPayer = address;
        break; // Stop looping once a suitable payer is found
      }
    }

    // If no suitable payer is found, use the fallback payer
    selectedPayer = selectedPayer || fallbackPayer;

    if (selectedPayer) {
      operations = addOperation(operations, {
        name: OperationName.transfer,
        from: {
          type: AddressType.account,
          address: selectedPayer,
        },
        to: {
          type: AddressType.account,
          address: to,
        },
        assetsSent: [{ assetId, amount }],
      });
    }
  });

  /**
   * `Transfer` receipts are produced from transfers:
   * - Wallet to Contract
   * - Contract to Contract
   */
  const transferReceipts = getReceiptsByType<TransactionResultTransferReceipt>(
    receipts,
    ReceiptType.Transfer
  );

  /**
   * `TransferOut` receipts are produced from transfer:
   * - Contract to Wallet
   */
  const transferOutReceipts = getReceiptsByType<TransactionResultTransferOutReceipt>(
    receipts,
    ReceiptType.TransferOut
  );

  [...transferReceipts, ...transferOutReceipts].forEach((receipt) => {
    const operation = extractTransferOperationFromReceipt(receipt, contractInputs, changeOutputs);

    operations = addOperation(operations, operation);
  });

  return operations;
}

/** @hidden */
export function getPayProducerOperations(outputs: Output[]): Operation[] {
  const coinOutputs = getOutputsCoin(outputs);
  const payProducerOperations = coinOutputs.reduce((prev, output) => {
    const operations = addOperation(prev, {
      name: OperationName.payBlockProducer,
      from: {
        type: AddressType.account,
        address: 'Network',
      },
      to: {
        type: AddressType.account,
        address: output.to.toString(),
      },
      assetsSent: [
        {
          assetId: output.assetId.toString(),
          amount: output.amount,
        },
      ],
    });

    return operations;
  }, [] as Operation[]);

  return payProducerOperations;
}

/** @hidden */
export function getContractCreatedOperations({ inputs, outputs }: InputOutputParam): Operation[] {
  const contractCreatedOutputs = getOutputsContractCreated(outputs);
  const input = getInputsCoinAndMessage(inputs)[0];
  const fromAddress = getInputAccountAddress(input);
  const contractCreatedOperations = contractCreatedOutputs.reduce((prev, contractCreatedOutput) => {
    const operations = addOperation(prev, {
      name: OperationName.contractCreated,
      from: {
        type: AddressType.account,
        address: fromAddress,
      },
      to: {
        type: AddressType.contract,
        address: contractCreatedOutput?.contractId || '',
      },
    });

    return operations;
  }, [] as Operation[]);

  return contractCreatedOperations;
}

/** @hidden */
export function getOperations({
  transactionType,
  inputs,
  outputs,
  receipts,
  abiMap,
  rawPayload,
  maxInputs,
  baseAssetId,
}: GetOperationParams): Operation[] {
  if (isTypeCreate(transactionType)) {
    return [...getContractCreatedOperations({ inputs, outputs })];
  }

  if (isTypeScript(transactionType)) {
    return [
      ...getTransferOperations({ inputs, outputs, receipts, baseAssetId }),
      ...getContractCallOperations({
        inputs,
        outputs,
        receipts,
        abiMap,
        rawPayload,
        maxInputs,
        baseAssetId,
      }),
      ...getWithdrawFromFuelOperations({ inputs, receipts, baseAssetId }),
    ];
  }
  // at this point we are sure it's a mint transaction
  return [...getPayProducerOperations(outputs)];
}
