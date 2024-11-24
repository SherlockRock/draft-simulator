type props = {
    user: { name: string };
};

function NavBar(props: props) {
    return (
        <div class="flex h-8 bg-purple-950">
            <p class="self-center">Hello {props.user.name}</p>
        </div>
    );
}

export default NavBar;
