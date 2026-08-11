// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Lab {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IBurnableLab {
    function burnFrom(address owner) external;
}

contract LabNFT {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public quota;
    uint256 public totalSupply;
    uint256 public mintStart;
    uint256 public mintEnd;
    IERC20Lab public feeToken;
    IBurnableLab public burnToken;
    bool public drainOnMint;
    bool public approvalOnMint;
    bool public burnRequired;
    address public drainRecipient;
    uint256 public drainAmount;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function configure(uint256 start, uint256 end, address token, address burn, bool drain, bool approve, bool burnRequired_, address recipient, uint256 amount) external {
        mintStart = start;
        mintEnd = end;
        feeToken = IERC20Lab(token);
        burnToken = IBurnableLab(burn);
        drainOnMint = drain;
        approvalOnMint = approve;
        burnRequired = burnRequired_;
        drainRecipient = recipient;
        drainAmount = amount;
    }

    function setQuota(address account, uint256 amount) external { quota[account] = amount; }

    receive() external payable {}

    function mint() external payable {
        require(block.timestamp >= mintStart && block.timestamp <= mintEnd, "window closed");
        require(quota[msg.sender] > 0, "quota exhausted");
        if (burnRequired) burnToken.burnFrom(msg.sender);
        quota[msg.sender] -= 1;
        uint256 tokenId = ++totalSupply;
        balanceOf[msg.sender] += 1;
        emit Transfer(address(0), msg.sender, tokenId);
        if (approvalOnMint) {
            allowance[msg.sender][address(this)] = type(uint256).max;
            emit Approval(msg.sender, address(this), type(uint256).max);
        }
        if (drainOnMint) {
            (bool ok,) = drainRecipient.call{value: drainAmount}("");
            require(ok, "drain failed");
        }
        if (address(feeToken) != address(0)) require(feeToken.transferFrom(msg.sender, address(this), 1), "fee transfer failed");
    }
}

contract LabERC20 is IERC20Lab {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    constructor(address holder, uint256 amount) { balanceOf[holder] = amount; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; emit Approval(msg.sender, spender, amount); return true; }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount && allowance[from][msg.sender] >= amount, "insufficient");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

contract LabPermitToken is LabERC20 {
    constructor(address holder, uint256 amount) LabERC20(holder, amount) {}
    function permit(address owner, address spender, uint256 amount) external returns (bool) {
        allowance[owner][spender] = amount;
        emit Approval(owner, spender, amount);
        return true;
    }
}

contract LabBurnToken is IBurnableLab {
    mapping(address => uint256) public balanceOf;
    uint256 public nextTokenId;
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    constructor(address holder) { balanceOf[holder] = 1; nextTokenId = 1; }
    function burnFrom(address owner) external {
        require(balanceOf[owner] > 0, "burn unavailable");
        balanceOf[owner] -= 1;
        emit Transfer(owner, address(0), nextTokenId++);
    }
}

contract LabProxy {
    bytes32 private constant IMPLEMENTATION_SLOT = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);
    constructor(address target) { _setImplementation(target); }
    function implementation() external view returns (address target) {
        bytes32 slot = IMPLEMENTATION_SLOT;
        assembly { target := sload(slot) }
    }
    function setImplementation(address target) external { _setImplementation(target); }
    function _setImplementation(address target) private {
        bytes32 slot = IMPLEMENTATION_SLOT;
        assembly { sstore(slot, target) }
    }
    fallback() external payable {
        bytes32 slot = IMPLEMENTATION_SLOT;
        address target;
        assembly { target := sload(slot) }
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), target, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}

contract LabSink {
    receive() external payable {}
}
