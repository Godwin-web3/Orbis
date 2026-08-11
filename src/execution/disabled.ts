import type { Broadcaster, GasStrategy, NonceManager, Signer } from "../domain/ports";
import type { SimulationResult, TransactionRequest } from "../domain/types";

export class DisabledSigner implements Signer { address = "disabled"; async sign(): Promise<`0x${string}`> { throw new Error("live signing is disabled"); } }
export class DisabledBroadcaster implements Broadcaster { async send(): Promise<`0x${string}`> { throw new Error("live broadcasting is disabled"); } }
export class FixedGasStrategy implements GasStrategy { gasLimit(simulation: SimulationResult) { return simulation.gasEstimate; } }
export class InMemoryNonceManager implements NonceManager { private nonce = 0; async reserve() { return this.nonce++; } async release(_chainKey: string, _nonce: number) {} }
export type { TransactionRequest };
