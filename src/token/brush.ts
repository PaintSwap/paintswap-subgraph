/* eslint-disable prefer-const */
import { BigInt } from "@graphprotocol/graph-ts";
import { BrushToken } from "../../generated/schema";
import { Transfer } from "../../generated/BrushToken/BEP20";
//import { fetchTokenDecimals, fetchTokenName, fetchTokenSymbol } from "./utils/bep20";

let ZERO_BI = BigInt.fromI32(0);
const ADDRESS_ZERO = "0x0000000000000000000000000000000000000000";
let BRUSH_ADDRESS = "0x85dec8c4B2680793661bCA91a8F129607571863d";

export function handleTransfer(event: Transfer): void {
    let token = BrushToken.load(BRUSH_ADDRESS);
    if (token === null) {
      token = new BrushToken(BRUSH_ADDRESS);
      token.totalBurned = ZERO_BI;
      token.save();
    }

    // Burning    
    if (event.params.to.toHex() == ADDRESS_ZERO) {
     token.totalBurned = token.totalBurned.plus(event.params.value);
     token.save();
   }
}
