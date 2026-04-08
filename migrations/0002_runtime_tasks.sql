-- runtime task 独立持久化表
-- 说明：
-- 1. 任务数据按 namespace + session_id 做会话级隔离
-- 2. payload 继续保存完整 task 列表 JSON，避免本阶段过早拆细字段
-- 3. session 快照中的 tasks 字段仍然保留，仅作为对外兼容返回结构

CREATE TABLE IF NOT EXISTS runtime_tasks (
	namespace TEXT NOT NULL,
	session_id TEXT NOT NULL,
	payload TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (namespace, session_id)
);
