import "./App.css";

const NEXT_STEPS = [
	"SessionStore -> Cloudflare D1",
	"AIClient -> AI SDK adapter",
	"Workspace -> @cloudflare/shell state.*",
	"Skills -> standard workspace-backed skill structure",
];

/**
 * Phase 0 占位前端。
 * 这里只保留最小项目壳，为后续 playground / inspector 留出稳定入口。
 */
function App() {
	return (
		<main className="app-shell">
			<section className="hero">
				<p className="eyebrow">Cloudflare Edge Agent Runtime</p>
				<h1>Agent Runtime Playground</h1>
				<p className="summary">
					Phase 0 已完成模板换轨。当前前端只保留最小壳，后续会接入
					session、workspace、skills 和 runtime inspection。
				</p>
			</section>

			<section className="panel">
				<h2>Current Focus</h2>
				<ul className="checkpoint-list">
					{NEXT_STEPS.map((item) => (
						<li key={item}>{item}</li>
					))}
				</ul>
			</section>

			<section className="panel panel-muted">
				<h2>Worker Placeholder</h2>
				<p>
					Worker 当前只暴露 runtime placeholder 接口，不提供 session、
					tool loop 或 workspace 操作。
				</p>
				<code>/api/runtime/health</code>
			</section>
		</main>
	);
}

export default App;
