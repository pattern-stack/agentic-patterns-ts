const mk = () => ({ role: {}, mission: {}, awareness: {}, background: {} });
export const boom = () => { throw new Error("should not be called"); };
export default mk();
