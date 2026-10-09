// Player rows are read with select("*") for the admin screens, which includes
// the bcrypt password hash. It is never shown anywhere and must not leave the
// server.
export const withoutPassword = (user) => {
    if (!user || typeof user !== "object") return user;
    const { password, ...rest } = user;
    return rest;
};
