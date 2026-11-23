using System;
using System.Threading.Tasks;

public interface IUserService
{
    User GetUser(int id);
}

public class UserService : IUserService
{
    public UserService()
    {
    }

    public User GetUser(int id)
    {
        return new User();
    }

    private async Task SaveUser(User user)
    {
        await Task.CompletedTask;
    }

    public int GetCount() => 42;
}

public struct User
{
    public int Id;
}