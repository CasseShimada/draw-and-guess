import { startServer } from "./server.js";

try {
  const running = await startServer();
  running.app.log.info(`画猜现场服务器已启动：${running.url}`);

  const shutdown = async (signal: string): Promise<void> => {
    running.app.log.info({ signal }, "正在安全关闭服务器");
    await running.close();
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
