import { ErrorCode } from "@draw-guess/protocol";

import { GameError } from "../errors.js";
import type {
  GameModeController,
  ModeContext,
  PassCommand,
  PassEffect
} from "../modes/game-mode.js";

export class PassCoordinator {
  async execute(
    context: ModeContext,
    controller: GameModeController,
    requesterId: string,
    command: PassCommand
  ): Promise<PassEffect> {
    const { room } = context;
    if (command.modeSessionId !== room.modeSessionId) {
      throw new GameError(ErrorCode.INVALID_STATE, "Pass 所属的模式会话已失效", 409);
    }
    const requester = room.players.get(requesterId);
    const target = room.players.get(command.targetPlayerId);
    if (!requester || !target) {
      throw new GameError(ErrorCode.UNAUTHORIZED, "Pass 玩家身份无效", 401);
    }
    const initiatedByHost = room.hostId === requesterId;
    if (!initiatedByHost && requesterId !== command.targetPlayerId) {
      throw new GameError(ErrorCode.FORBIDDEN, "普通玩家不能代他人 Pass", 403);
    }
    if (room.runControl.status === "paused" && !initiatedByHost) {
      throw new GameError(
        ErrorCode.INVALID_STATE,
        "暂停期间只有逻辑房主可以代当前玩家 Pass",
        409
      );
    }
    const actors = controller.passableActors(context, requesterId);
    if (
      !actors.some(
        (actor) =>
          actor.actorStepId === command.actorStepId &&
          actor.targetPlayerId === command.targetPlayerId
      )
    ) {
      throw new GameError(ErrorCode.INVALID_STATE, "目标玩家当前不可 Pass", 409);
    }
    return controller.resolvePass(context, command, initiatedByHost);
  }
}
