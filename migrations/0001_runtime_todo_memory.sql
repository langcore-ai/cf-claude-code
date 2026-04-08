-- runtime_todo_memory: 最近一次非空 Todo 快照
-- 说明：
-- 1. 该表只服务 runtime 内部的 Todo 连续性提示
-- 2. 通过 (namespace, session_id) 复合主键隔离不同 runtime 命名空间
-- 3. 使用 IF NOT EXISTS 保证重复执行迁移时幂等
CREATE TABLE IF NOT EXISTS runtime_todo_memory (
	namespace TEXT NOT NULL,
	session_id TEXT NOT NULL,
	payload TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (namespace, session_id)
);
