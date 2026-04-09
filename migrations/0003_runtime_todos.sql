-- runtime todo 独立持久化表
-- 说明：
-- 1. 当前会话的 todo 列表按 namespace + session_id 做会话级隔离
-- 2. payload 继续保存完整 todo 列表 JSON，避免本阶段过早拆细字段
-- 3. runtime_todo_memory 继续仅承担最近一次非空 todo 快照职责，不替代当前 todo 主存储

CREATE TABLE IF NOT EXISTS runtime_todos (
	namespace TEXT NOT NULL,
	session_id TEXT NOT NULL,
	payload TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (namespace, session_id)
);
