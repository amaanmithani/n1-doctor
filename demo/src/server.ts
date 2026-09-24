import './tracing.js';
const { app } = await import('./app.js');
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`blog-api on :${port}`));
