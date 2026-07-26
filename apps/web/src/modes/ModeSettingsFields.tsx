import type { GameModeSettings } from "@draw-guess/shared-types";

import { formatDuration } from "./common.js";

export function ModeSettingsFields({
  disabled = false,
  idPrefix,
  onChange,
  value
}: {
  disabled?: boolean;
  idPrefix: string;
  onChange: (value: GameModeSettings) => void;
  value: GameModeSettings;
}) {
  switch (value.mode) {
    case "classic":
      return (
        <div className="settings-grid">
          <label>
            绘画时间
            <input
              data-setting="drawing-seconds"
              data-ui="number-input"
              disabled={disabled}
              max={180}
              min={15}
              onChange={(event) =>
                onChange({
                  mode: "classic",
                  settings: {
                    ...value.settings,
                    drawingSeconds: event.currentTarget.valueAsNumber
                  }
                })
              }
              type="number"
              value={value.settings.drawingSeconds}
            />
          </label>
          <label>
            选词时间
            <input
              data-setting="selection-seconds"
              data-ui="number-input"
              disabled={disabled}
              max={60}
              min={5}
              onChange={(event) =>
                onChange({
                  mode: "classic",
                  settings: {
                    ...value.settings,
                    selectionSeconds: event.currentTarget.valueAsNumber
                  }
                })
              }
              type="number"
              value={value.settings.selectionSeconds}
            />
          </label>
          <label>
            轮数
            <input
              data-setting="rounds"
              data-ui="number-input"
              disabled={disabled}
              max={5}
              min={1}
              onChange={(event) =>
                onChange({
                  mode: "classic",
                  settings: {
                    ...value.settings,
                    rounds: event.currentTarget.valueAsNumber
                  }
                })
              }
              type="number"
              value={value.settings.rounds}
            />
          </label>
        </div>
      );
    case "reference-copy": {
      const rangeId = `${idPrefix}-duration-range`;
      const exactId = `${idPrefix}-duration-exact`;
      return (
        <div className="settings-grid">
          <div className="duration-setting">
            <label htmlFor={rangeId}>
              临摹时长
              <output>{formatDuration(value.settings.durationSeconds)}</output>
            </label>
            <input
              aria-label="临摹时长滑块"
              data-setting="duration-seconds"
              data-ui="range-input"
              disabled={disabled}
              id={rangeId}
              max={10_800}
              min={1}
              onChange={(event) =>
                onChange({
                  mode: "reference-copy",
                  settings: {
                    ...value.settings,
                    durationSeconds: event.currentTarget.valueAsNumber
                  }
                })
              }
              step={1}
              type="range"
              value={value.settings.durationSeconds}
            />
            <label htmlFor={exactId}>精确秒数（1～10800）</label>
            <input
              data-setting="duration-seconds-exact"
              data-ui="number-input"
              disabled={disabled}
              id={exactId}
              inputMode="numeric"
              max={10_800}
              min={1}
              onChange={(event) => {
                const durationSeconds = event.currentTarget.valueAsNumber;
                if (Number.isFinite(durationSeconds)) {
                  onChange({
                    mode: "reference-copy",
                    settings: {
                      ...value.settings,
                      durationSeconds: Math.min(
                        10_800,
                        Math.max(1, Math.trunc(durationSeconds))
                      )
                    }
                  });
                }
              }}
              step={1}
              type="number"
              value={value.settings.durationSeconds}
            />
          </div>
          <label>
            盲选秒数
            <input
              data-setting="voting-seconds"
              data-ui="number-input"
              disabled={disabled}
              max={600}
              min={10}
              onChange={(event) =>
                onChange({
                  mode: "reference-copy",
                  settings: {
                    ...value.settings,
                    votingSeconds: event.currentTarget.valueAsNumber
                  }
                })
              }
              type="number"
              value={value.settings.votingSeconds}
            />
          </label>
        </div>
      );
    }
    case "draw-relay":
      return (
        <div className="settings-grid">
          <label>
            绘画秒数
            <input
              data-setting="drawing-seconds"
              data-ui="number-input"
              disabled={disabled}
              max={10_800}
              min={1}
              onChange={(event) =>
                onChange({
                  mode: "draw-relay",
                  settings: {
                    ...value.settings,
                    drawingSeconds: event.currentTarget.valueAsNumber
                  }
                })
              }
              type="number"
              value={value.settings.drawingSeconds}
            />
          </label>
          <label>
            猜词秒数
            <input
              data-setting="guessing-seconds"
              data-ui="number-input"
              disabled={disabled}
              max={600}
              min={1}
              onChange={(event) =>
                onChange({
                  mode: "draw-relay",
                  settings: {
                    ...value.settings,
                    guessingSeconds: event.currentTarget.valueAsNumber
                  }
                })
              }
              type="number"
              value={value.settings.guessingSeconds}
            />
          </label>
        </div>
      );
  }
}
